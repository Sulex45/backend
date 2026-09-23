/**
 * Tests for the admin keypair cache (#227).
 *
 * getAdminKeypair() used to re-derive the Ed25519 keypair from the secret on
 * every call, which in the cron loop meant one derivation per project per
 * cycle. It now derives once and reuses the result.
 */

const mockConfig: Record<string, unknown> = {
  STELLAR_NETWORK: "testnet",
  ADMIN_SECRET_KEY: "",
  RPC_URL: "https://soroban-testnet.stellar.org",
  DB_POOL_MIN: 2,
  DB_POOL_MAX: 10,
  DB_POOL_ACQUIRE_TIMEOUT_MS: 5000,
  DB_POOL_HEALTH_CHECK_INTERVAL_MS: 30000,
  RPC_BREAKER_FAILURE_THRESHOLD: 5,
  RPC_BREAKER_RECOVERY_TIMEOUT_MS: 30000,
  TX_MAX_RETRIES: 4,
  TX_RETRY_BASE_DELAY_MS: 200,
  TX_RETRY_MAX_DELAY_MS: 10000,
};

jest.mock("../config", () => ({
  get config() {
    return mockConfig;
  },
}));

jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    // Fresh object per call so identity comparison proves the cache is used.
    fromSecret: jest.fn((secret: string) => ({ publicKey: () => `PUB:${secret}` })),
    random: jest.fn().mockReturnValue({ secret: () => "SRANDOM" }),
  },
  rpc: {
    Server: jest.fn(),
    Api: { GetTransactionStatus: { NOT_FOUND: "NOT_FOUND", FAILED: "FAILED" } },
  },
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  TransactionBuilder: { fromXDR: jest.fn() },
  Account: jest.fn(),
  xdr: {
    LedgerKey: { account: jest.fn() },
    LedgerKeyAccount: jest.fn(),
  },
}));

import { getAdminKeypair, resetAdminKeypairCache } from "../lib/stellar";
import { Keypair } from "@stellar/stellar-sdk";

const fromSecret = Keypair.fromSecret as unknown as jest.Mock;

describe("getAdminKeypair caching (#227)", () => {
  beforeEach(() => {
    resetAdminKeypairCache();
    fromSecret.mockClear();
    mockConfig.ADMIN_SECRET_KEY = "SSECRET1";
  });

  it("derives the keypair only once across repeated calls", () => {
    getAdminKeypair();
    getAdminKeypair();
    getAdminKeypair();

    expect(fromSecret).toHaveBeenCalledTimes(1);
    expect(fromSecret).toHaveBeenCalledWith("SSECRET1");
  });

  it("returns the identical cached instance on subsequent calls", () => {
    const first = getAdminKeypair();
    const second = getAdminKeypair();

    expect(second).toBe(first);
  });

  it("stays cached across a simulated cron cycle over many projects", () => {
    for (let projectId = 1; projectId <= 50; projectId++) {
      getAdminKeypair();
    }

    expect(fromSecret).toHaveBeenCalledTimes(1);
  });

  it("throws the same error when ADMIN_SECRET_KEY is not set", () => {
    mockConfig.ADMIN_SECRET_KEY = "";

    expect(() => getAdminKeypair()).toThrow("ADMIN_SECRET_KEY not set");
    expect(fromSecret).not.toHaveBeenCalled();
  });

  it("still throws on a missing secret even after a successful derivation", () => {
    getAdminKeypair();
    expect(fromSecret).toHaveBeenCalledTimes(1);

    mockConfig.ADMIN_SECRET_KEY = "";
    expect(() => getAdminKeypair()).toThrow("ADMIN_SECRET_KEY not set");
  });

  it("re-derives when the configured secret changes", () => {
    const first = getAdminKeypair();

    mockConfig.ADMIN_SECRET_KEY = "SSECRET2";
    const second = getAdminKeypair();

    expect(fromSecret).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.publicKey()).toBe("PUB:SSECRET2");
  });

  it("resetAdminKeypairCache forces the next call to derive again", () => {
    getAdminKeypair();
    resetAdminKeypairCache();
    getAdminKeypair();

    expect(fromSecret).toHaveBeenCalledTimes(2);
  });
});
import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../routes/admin";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { resetIdempotencyState } from "../lib/scoreService";

jest.mock("../lib/registry", () => {
  class RpcDegradedError extends Error {
    constructor(message?: string) {
      super(message ?? "RPC is degraded");
      this.name = "RpcDegradedError";
    }
  }
  return {
    updateImpactScore: jest.fn(),
    getTotalProjects: jest.fn(),
    RpcDegradedError,
  };
});
jest.mock("../routes/iot");
jest.mock("../lib/scoring");
jest.mock("../config", () => ({
  config: {
    ADMIN_API_KEY: "test-key",
  },
}));

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(errorHandler);
  return app;
}

const authHeader = { Authorization: "Bearer test-key" };

describe("admin /update-scores response shape", () => {
  let app: Express;

  beforeEach(() => {
    resetIdempotencyState();
    app = buildApp();
    jest.clearAllMocks();
    (iot.getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 85,
      power_output_kw: 500,
      max_power_kw: 1000,
    });
    (iot.getSatelliteData as jest.Mock).mockReturnValue({
      forest_density_pct: 60,
      ndvi_score: 0.6,
    });
    (scoring.computeScores as jest.Mock).mockReturnValue({
      credit_quality: 85,
      green_impact: 70,
    });
    (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-hash");
    (registry.getTotalProjects as jest.Mock).mockResolvedValue(2);
  });

  it("response has updated field (number)", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    expect(res.body).toHaveProperty("updated");
    expect(typeof res.body.updated).toBe("number");
  });

  it("response has results field (array)", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it("response has errors field (array)", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    expect(res.body).toHaveProperty("errors");
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it("response shape matches { updated, results, errors }", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    expect(
      Object.keys(res.body)
        .filter((k) => k !== "skipped")
        .sort(),
    ).toEqual(["errors", "results", "updated"]);
  });

  it("results entries have correct shape", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    for (const entry of res.body.results) {
      expect(entry).toHaveProperty("project_id");
      expect(entry).toHaveProperty("tx_hash");
      expect(entry).toHaveProperty("credit_quality");
      expect(entry).toHaveProperty("green_impact");
      expect(typeof entry.project_id).toBe("number");
      expect(typeof entry.tx_hash).toBe("string");
      expect(typeof entry.credit_quality).toBe("number");
      expect(typeof entry.green_impact).toBe("number");
    }
  });

  it("errors entries have correct shape", async () => {
    (registry.updateImpactScore as jest.Mock)
      .mockResolvedValueOnce("tx-hash-1")
      .mockRejectedValueOnce(new Error("RPC error"));
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({ project_ids: [1, 2] })
      .expect(200);
    expect(res.body.errors).toHaveLength(1);
    const entry = res.body.errors[0];
    expect(entry).toHaveProperty("project_id");
    expect(entry).toHaveProperty("error");
    expect(typeof entry.project_id).toBe("number");
    expect(typeof entry.error).toBe("object");
  });
});