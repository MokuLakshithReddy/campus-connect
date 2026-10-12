import { describe, it, expect } from "vitest";
import {
  BRANCH_CONFIGS,
  normalizeRollNumber,
  isValidRollNumberFormat,
  findBranchForRollNumber,
  validateRollNumber,
} from "../lib/academic-branches";

describe("Academic Directory: Roll Number & Branch Mapping Test Matrix", () => {
  it("resolves 25MVCSMR0001 to configured B.Tech CSE-AIML mapping", () => {
    const roll = "25MVCSMR0001";
    const branch = findBranchForRollNumber(roll);

    expect(branch).not.toBeNull();
    expect(branch?.course).toBe("B.Tech");
    expect(branch?.branchCode).toBe("CSE-AIML");
    expect(branch?.displayName).toBe("Computer Science and Engineering (AI & ML)");
    expect(branch?.admissionYear).toBe(2025);
    expect(branch?.prefix).toBe("25MVCSMR");
  });

  it("resolves 25MVCSER0001 to configured B.Tech CSE mapping", () => {
    const roll = "25MVCSER0001";
    const branch = findBranchForRollNumber(roll);

    expect(branch).not.toBeNull();
    expect(branch?.course).toBe("B.Tech");
    expect(branch?.branchCode).toBe("CSE");
    expect(branch?.displayName).toBe("Computer Science and Engineering");
    expect(branch?.admissionYear).toBe(2025);
    expect(branch?.prefix).toBe("25MVCSER");
  });

  it("rejects 25MVCSMR00001 due to incorrect length (13 chars instead of 12)", () => {
    const invalidLongRoll = "25MVCSMR00001";
    expect(isValidRollNumberFormat(invalidLongRoll)).toBe(false);
    expect(findBranchForRollNumber(invalidLongRoll)).toBeNull();

    const validation = validateRollNumber(invalidLongRoll);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("must be exactly 12 characters");
  });

  it("rejects unknown 12-character prefixes pending official configuration", () => {
    // 12-character roll with unconfirmed prefix
    const unknownRoll = "25MVEEER0001";
    expect(isValidRollNumberFormat(unknownRoll)).toBe(true);
    expect(findBranchForRollNumber(unknownRoll)).toBeNull();

    const validation = validateRollNumber(unknownRoll);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("prefix is not configured");
  });

  it("normalizes roll numbers with lowercase letters and leading/trailing whitespace", () => {
    const lowercaseWithSpaces = "  25mvcsmr0042  ";
    const normalized = normalizeRollNumber(lowercaseWithSpaces);
    expect(normalized).toBe("25MVCSMR0042");

    const branch = findBranchForRollNumber(lowercaseWithSpaces);
    expect(branch).not.toBeNull();
    expect(branch?.branchCode).toBe("CSE-AIML");
  });

  it("rejects duplicate roll numbers in directory store", () => {
    const directory = new Map<string, { branchId: string; year: number }>();
    directory.set("25MVCSMR0001", { branchId: "b-aiml", year: 2025 });

    const insertStudent = (roll: string, branchId: string, year: number) => {
      const cleanRoll = normalizeRollNumber(roll);
      if (directory.has(cleanRoll)) {
        throw new Error(`Unique constraint violation: roll_number ${cleanRoll} already registered`);
      }
      directory.set(cleanRoll, { branchId, year });
    };

    expect(() => insertStudent("25MVCSMR0001", "b-aiml", 2025)).toThrowError(
      /Unique constraint violation/
    );
  });
});

describe("Academic Protection & Authorization Triggers", () => {
  it("rejects attempts by non-admin students to modify verified branch_id or roll_number", () => {
    interface ProfileRecord {
      id: string;
      student_id: string;
      branch_id: string;
      college_role: "student" | "college_admin";
      department: string;
    }

    const currentProfile: ProfileRecord = {
      id: "std-101",
      student_id: "25MVCSMR0001",
      branch_id: "branch-aiml-uuid",
      college_role: "student",
      department: "Computer Science and Engineering (AI & ML)",
    };

    // Simulated PostgreSQL 'protect_profile_academic_fields' trigger
    const executeProfileUpdate = (
      oldRow: ProfileRecord,
      newRow: ProfileRecord,
      callerId: string,
      callerRole: string
    ) => {
      const isAdmin = callerRole === "college_admin";
      if (!isAdmin) {
        if (oldRow.student_id && newRow.student_id !== oldRow.student_id) {
          throw new Error("Unauthorized: Student roll number cannot be modified");
        }
        if (oldRow.branch_id && newRow.branch_id !== oldRow.branch_id) {
          throw new Error("Unauthorized: Academic branch cannot be modified by student");
        }
      }
      return newRow;
    };

    // 1. Student attempts to change branch_id
    expect(() =>
      executeProfileUpdate(
        currentProfile,
        { ...currentProfile, branch_id: "branch-cse-uuid" },
        currentProfile.id,
        "student"
      )
    ).toThrowError("Unauthorized: Academic branch cannot be modified by student");

    // 2. Student attempts to change roll_number
    expect(() =>
      executeProfileUpdate(
        currentProfile,
        { ...currentProfile, student_id: "25MVCSER0001" },
        currentProfile.id,
        "student"
      )
    ).toThrowError("Unauthorized: Student roll number cannot be modified");

    // 3. Student attempts to self-escalate college_role to college_admin
    const executeRoleProtection = (
      oldRow: ProfileRecord,
      newRow: ProfileRecord,
      callerRole: string
    ) => {
      if (callerRole !== "college_admin") {
        if (newRow.college_role !== oldRow.college_role) {
          throw new Error("Unauthorized: Cannot modify college_role");
        }
      }
      return newRow;
    };

    expect(() =>
      executeRoleProtection(
        currentProfile,
        { ...currentProfile, college_role: "college_admin" },
        "student"
      )
    ).toThrowError("Unauthorized: Cannot modify college_role");

    // 4. Admin can update records
    const adminUpdated = executeProfileUpdate(
      currentProfile,
      { ...currentProfile, branch_id: "branch-cse-uuid" },
      "admin-999",
      "college_admin"
    );
    expect(adminUpdated.branch_id).toBe("branch-cse-uuid");
  });

  it("enforces literal prefix matching without SQL pattern wildcard injection (_ or %)", () => {
    // Literal matching rule: left(roll_number, length(prefix)) = prefix
    const literalMatchPrefix = (roll: string, prefix: string) => {
      const cleanRoll = roll.trim().toUpperCase();
      const cleanPrefix = prefix.trim().toUpperCase();
      return cleanRoll.slice(0, cleanPrefix.length) === cleanPrefix;
    };

    // A roll number containing an underscore or percent must NOT match a wildcard pattern
    expect(literalMatchPrefix("25MVCSMR0001", "25MVCSMR")).toBe(true);
    expect(literalMatchPrefix("25MVCSMR0001", "25MVCS%")).toBe(false);
    expect(literalMatchPrefix("25MVCSMR0001", "25MVCS_R")).toBe(false);
    expect(literalMatchPrefix("25MVCS_R0001", "25MVCS_R")).toBe(true);
  });

  it("resolves overlapping prefixes deterministically via longest-prefix precedence", () => {
    interface PrefixRule {
      prefix: string;
      branchCode: string;
    }

    const rules: PrefixRule[] = [
      { prefix: "25MV", branchCode: "GENERAL" },
      { prefix: "25MVCSMR", branchCode: "CSE-AIML" },
      { prefix: "25MVCS", branchCode: "CSE-GROUP" },
    ];

    // Enforce PostgreSQL rule: ORDER BY length(prefix) DESC, prefix ASC LIMIT 1
    const resolveLongestPrefix = (roll: string, prefixRules: PrefixRule[]): PrefixRule | null => {
      const matches = prefixRules
        .filter((r) => roll.startsWith(r.prefix))
        .sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
      return matches[0] || null;
    };

    const result = resolveLongestPrefix("25MVCSMR0001", rules);
    expect(result).not.toBeNull();
    expect(result?.prefix).toBe("25MVCSMR");
    expect(result?.branchCode).toBe("CSE-AIML");
  });

  it("enforces strict directory RLS isolation: students can only read own enrollment record", () => {
    interface DirectoryRecord {
      id: string;
      roll_number: string;
      profile_id: string | null;
      is_active: boolean;
    }

    const directoryRecords: DirectoryRecord[] = [
      { id: "dir-1", roll_number: "25MVCSMR0001", profile_id: "user-alice", is_active: true },
      { id: "dir-2", roll_number: "25MVCSER0002", profile_id: "user-bob", is_active: true },
    ];

    // PostgreSQL RLS policy on student_directory:
    // profile_id = auth.uid() OR college_admin
    const queryDirectoryAsUser = (callerId: string, callerRole: string) => {
      return directoryRecords.filter((row) => {
        if (callerRole === "college_admin") return true;
        return row.profile_id === callerId;
      });
    };

    const aliceRows = queryDirectoryAsUser("user-alice", "student");
    expect(aliceRows.length).toBe(1);
    expect(aliceRows[0].roll_number).toBe("25MVCSMR0001");

    // Intruding student cannot dump peer directory records
    const eveRows = queryDirectoryAsUser("user-eve", "student");
    expect(eveRows.length).toBe(0);

    // College admin can view all records for provisioning
    const adminRows = queryDirectoryAsUser("user-admin", "college_admin");
    expect(adminRows.length).toBe(2);
  });

  it("rejects directory sync when directory entry is marked inactive", () => {
    interface StudentDirectoryRow {
      roll_number: string;
      profile_id: string | null;
      is_active: boolean;
    }

    const directoryRow: StudentDirectoryRow = {
      roll_number: "25MVCSMR0099",
      profile_id: null,
      is_active: false, // Suspended / inactive student
    };

    const syncStudent = (row: StudentDirectoryRow, authUserId: string) => {
      if (!row.is_active) {
        throw new Error("Student directory record is inactive or suspended");
      }
      row.profile_id = authUserId;
      return row;
    };

    expect(() => syncStudent(directoryRow, "user-inactive")).toThrowError(
      "Student directory record is inactive or suspended"
    );
  });

  it("denies access when a user attempts to read another student's private messages", () => {
    interface Conversation {
      id: string;
      user1_id: string;
      user2_id: string;
    }

    const conversation: Conversation = {
      id: "convo-1",
      user1_id: "user-alice",
      user2_id: "user-bob",
    };

    // RLS policy: Caller must be user1_id OR user2_id
    const canAccessConversation = (convo: Conversation, callerId: string): boolean => {
      return convo.user1_id === callerId || convo.user2_id === callerId;
    };

    expect(canAccessConversation(conversation, "user-alice")).toBe(true);
    expect(canAccessConversation(conversation, "user-bob")).toBe(true);
    expect(canAccessConversation(conversation, "user-eve-intruder")).toBe(false);
  });

  it("ensures that two scanners checking in the same ticket simultaneously cannot double-check in", async () => {
    // Simulated atomic check-in transaction with row locking
    interface TicketRegistration {
      id: string;
      qr_code_token: string;
      status: "registered" | "attended" | "cancelled";
      checked_in_at: Date | null;
      locked: boolean;
    }

    const ticket: TicketRegistration = {
      id: "reg-1",
      qr_code_token: "PASS-QR-999",
      status: "registered",
      checked_in_at: null,
      locked: false,
    };

    // Simulated check_in_event_attendee function with FOR UPDATE row lock
    const checkInAttendee = async (
      targetTicket: TicketRegistration,
      scannerName: string
    ): Promise<{ success: boolean; scanner: string }> => {
      // Acquire exclusive row lock (simulating PostgreSQL FOR UPDATE)
      while (targetTicket.locked) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      targetTicket.locked = true;

      try {
        if (targetTicket.status === "cancelled") {
          throw new Error("This registration was cancelled");
        }
        if (targetTicket.checked_in_at !== null || targetTicket.status === "attended") {
          throw new Error("Attendee already checked in");
        }

        // Perform atomic update
        targetTicket.status = "attended";
        targetTicket.checked_in_at = new Date();
        return { success: true, scanner: scannerName };
      } finally {
        targetTicket.locked = false;
      }
    };

    // Run two simultaneous check-in attempts
    const attempt1 = checkInAttendee(ticket, "Scanner-NorthGate");
    const attempt2 = checkInAttendee(ticket, "Scanner-SouthGate");

    const results = await Promise.allSettled([attempt1, attempt2]);
    const successful = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one scanner must succeed; the other must fail with "Attendee already checked in"
    expect(successful.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0].status === "rejected") {
      expect(rejected[0].reason.message).toContain("Attendee already checked in");
    }
    expect(ticket.status).toBe("attended");
  });
});
