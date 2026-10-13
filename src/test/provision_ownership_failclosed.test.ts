import { describe, it, expect } from "vitest";
import http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";

describe("Provisioning Script: Fail-Closed Profile Ownership Resolution", () => {
  const scriptPath = path.resolve(__dirname, "../../scripts/provision-student.cjs");

  function runProvisioningScript(env: NodeJS.ProcessEnv, rollNumber = "25MVCSMR0001"): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [scriptPath, rollNumber, "Computer Science & Engineering", "1st Year", "Test Student"],
        { env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout,
            stderr,
          });
        }
      );
    });
  }

  it("aborts and creates no auth user when existing profile query returns HTTP 500 error", async () => {
    let authUserCreateAttempts = 0;
    let ownershipCheckExecuted = false;

    const server = http.createServer((req, res) => {
      const url = req.url || "";

      if (url.includes("/rest/v1/student_directory")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              roll_number: "25MVCSMR0001",
              branch_id: "b-cs-aiml",
              admission_year: 2025,
              is_active: true,
              profile_id: null,
            },
          ])
        );
        return;
      }

      if (url.includes("/rest/v1/rpc/resolve_student_branch")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            branch_id: "b-cs-aiml",
            display_name: "Computer Science & Engineering",
            branch_code: "CSE-AIML",
            admission_year: 2025,
            prefix: "25MVCSMR",
          })
        );
        return;
      }

      if (url.includes("/rest/v1/profiles?or=")) {
        ownershipCheckExecuted = true;
        // Simulate database outage / server error during ownership check
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Internal server error: database unreachable" }));
        return;
      }

      if (url.includes("/auth/v1/admin/users")) {
        authUserCreateAttempts++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "unauthorized-created-user" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const result = await runProvisioningScript({
        SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      });

      expect(ownershipCheckExecuted).toBe(true);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Existing profile ownership query failed");
      expect(result.stderr).toContain("Fail-closed security requires verified confirmation that no conflicting profile exists");

      // CRITICAL SECURITY ASSERTION: No authentication account was created or modified
      expect(authUserCreateAttempts).toBe(0);
    } finally {
      server.close();
    }
  });

  it("aborts and creates no auth user when existing profile query returns non-array payload", async () => {
    let authUserCreateAttempts = 0;
    let ownershipCheckExecuted = false;

    const server = http.createServer((req, res) => {
      const url = req.url || "";

      if (url.includes("/rest/v1/student_directory")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              roll_number: "25MVCSMR0001",
              branch_id: "b-cs-aiml",
              admission_year: 2025,
              is_active: true,
              profile_id: null,
            },
          ])
        );
        return;
      }

      if (url.includes("/rest/v1/rpc/resolve_student_branch")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            branch_id: "b-cs-aiml",
            display_name: "Computer Science & Engineering",
            branch_code: "CSE-AIML",
            admission_year: 2025,
            prefix: "25MVCSMR",
          })
        );
        return;
      }

      if (url.includes("/rest/v1/profiles?or=")) {
        ownershipCheckExecuted = true;
        // Unexpected object response instead of array
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected structure" }));
        return;
      }

      if (url.includes("/auth/v1/admin/users")) {
        authUserCreateAttempts++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "unauthorized-created-user" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const result = await runProvisioningScript({
        SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      });

      expect(ownershipCheckExecuted).toBe(true);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Existing profile ownership query failed");
      expect(result.stderr).toContain("Fail-closed security requires verified confirmation that no conflicting profile exists");

      // CRITICAL SECURITY ASSERTION: No authentication account was created or modified
      expect(authUserCreateAttempts).toBe(0);
    } finally {
      server.close();
    }
  });

  it("proceeds to account provisioning ONLY when query successfully returns 0 conflicting rows", async () => {
    let authUserCreateAttempts = 0;
    let ownershipCheckExecuted = false;

    const server = http.createServer((req, res) => {
      const url = req.url || "";

      if (url.includes("/rest/v1/student_directory")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              roll_number: "25MVCSMR0001",
              branch_id: "b-cs-aiml",
              admission_year: 2025,
              is_active: true,
              profile_id: null,
            },
          ])
        );
        return;
      }

      if (url.includes("/rest/v1/rpc/resolve_student_branch")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            branch_id: "b-cs-aiml",
            display_name: "Computer Science & Engineering",
            branch_code: "CSE-AIML",
            admission_year: 2025,
            prefix: "25MVCSMR",
          })
        );
        return;
      }

      if (url.includes("/rest/v1/profiles?or=")) {
        ownershipCheckExecuted = true;
        // Successful response with exactly 0 rows
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      if (url.includes("/auth/v1/admin/users")) {
        authUserCreateAttempts++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "user-newly-created" }));
        return;
      }

      if (url.includes("/rest/v1/profiles?id=eq.user-newly-created")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "user-newly-created",
              username: "25MVCSMR0001",
              student_id: "25MVCSMR0001",
              college_role: "student",
              is_verified: true,
              must_change_password: true,
            },
          ])
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const result = await runProvisioningScript({
        SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      });

      expect(ownershipCheckExecuted).toBe(true);
      expect(authUserCreateAttempts).toBe(1);
      expect(result.stdout).toContain("Verified: No conflicting existing profile found for roll number 25MVCSMR0001");
      expect(result.stdout).toContain("SUCCESS: Student 25MVCSMR0001 is verified, provisioned");
      expect(result.code).toBe(0);
    } finally {
      server.close();
    }
  });
});
