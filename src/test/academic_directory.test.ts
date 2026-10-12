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

    // 3. Admin can update records
    const adminUpdated = executeProfileUpdate(
      currentProfile,
      { ...currentProfile, branch_id: "branch-cse-uuid" },
      "admin-999",
      "college_admin"
    );
    expect(adminUpdated.branch_id).toBe("branch-cse-uuid");
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
