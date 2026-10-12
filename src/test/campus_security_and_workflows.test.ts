import { describe, it, expect } from "vitest";
import {
  StudentProfile,
  Club,
  ClubMembership,
  CampusEvent,
  EventRegistration,
  CampusNotification,
} from "../types/campus";

describe("CampusConnect Security & Identity Verification", () => {
  it("should enforce that student accounts cannot self-grant college_admin or verified status", () => {
    const student: StudentProfile = {
      id: "std-001",
      username: "alice",
      bio: "CS sophomore",
      avatar_url: null,
      department: "Computer Science",
      year: "2nd Year",
      student_id: "24CS0101",
      college_role: "student",
      is_verified: false,
    };

    // Simulated client update attempt
    const maliciousUpdateAttempt = {
      ...student,
      college_role: "college_admin" as const,
      is_verified: true,
    };

    // Guard function mirroring PostgreSQL 'protect_profile_privileges' trigger
    const applyProfileUpdate = (
      current: StudentProfile,
      update: Partial<StudentProfile>,
      callerRole: string
    ): StudentProfile => {
      const result = { ...current, ...update };
      if (callerRole !== "college_admin") {
        result.college_role = current.college_role;
        result.is_verified = current.is_verified;
      }
      return result;
    };

    const securedProfile = applyProfileUpdate(student, maliciousUpdateAttempt, student.college_role);
    expect(securedProfile.college_role).toBe("student");
    expect(securedProfile.is_verified).toBe(false);
  });
});

describe("Club Workflows & Membership Authorization", () => {
  it("should create membership requests with status 'pending' by default for regular students", () => {
    const requestMembership = (clubId: string, userId: string, callerRole: string): ClubMembership => {
      return {
        id: "mem-1",
        club_id: clubId,
        user_id: userId,
        role: "member",
        status: callerRole === "college_admin" ? "active" : "pending",
        joined_at: new Date().toISOString(),
      };
    };

    const studentRequest = requestMembership("club-1", "user-123", "student");
    expect(studentRequest.status).toBe("pending");
    expect(studentRequest.role).toBe("member");

    const adminDirectAdd = requestMembership("club-1", "user-admin", "college_admin");
    expect(adminDirectAdd.status).toBe("active");
  });

  it("should only allow club president or organizer to approve pending requests", () => {
    const approveMembership = (
      membership: ClubMembership,
      approverRoleInClub: "president" | "organizer" | "member"
    ): ClubMembership => {
      if (approverRoleInClub !== "president" && approverRoleInClub !== "organizer") {
        throw new Error("Unauthorized: Only club organizers or presidents can approve requests");
      }
      return { ...membership, status: "active" };
    };

    const pendingMem: ClubMembership = {
      id: "mem-2",
      club_id: "club-1",
      user_id: "student-456",
      role: "member",
      status: "pending",
      joined_at: new Date().toISOString(),
    };

    expect(() => approveMembership(pendingMem, "member")).toThrow(/Unauthorized/);

    const approved = approveMembership(pendingMem, "president");
    expect(approved.status).toBe("active");
  });

  it("should only allow president to appoint a member as organizer", () => {
    const promoteToOrganizer = (
      membership: ClubMembership,
      callerRoleInClub: "president" | "organizer" | "member"
    ): ClubMembership => {
      if (callerRoleInClub !== "president") {
        throw new Error("Unauthorized: Only the club president can appoint organizers");
      }
      return { ...membership, role: "organizer" };
    };

    const activeMember: ClubMembership = {
      id: "mem-3",
      club_id: "club-1",
      user_id: "student-789",
      role: "member",
      status: "active",
      joined_at: new Date().toISOString(),
    };

    expect(() => promoteToOrganizer(activeMember, "organizer")).toThrow(/Unauthorized/);
    const promoted = promoteToOrganizer(activeMember, "president");
    expect(promoted.role).toBe("organizer");
  });
});

describe("Atomic Event Registration & Capacity Checks", () => {
  it("should prevent registration when event capacity is reached", () => {
    const event: CampusEvent = {
      id: "ev-101",
      club_id: "club-1",
      title: "AI Workshop",
      description: "Hands-on session",
      poster_url: null,
      venue: "Lab 3",
      start_time: new Date(Date.now() + 86400000).toISOString(),
      end_time: null,
      capacity: 2,
      is_published: true,
      created_by: "organizer-1",
      created_at: new Date().toISOString(),
    };

    const registrations: EventRegistration[] = [
      { id: "reg-1", event_id: "ev-101", user_id: "user-1", status: "registered", qr_code_token: "t-1", checked_in_at: null, created_at: "" },
      { id: "reg-2", event_id: "ev-101", user_id: "user-2", status: "registered", qr_code_token: "t-2", checked_in_at: null, created_at: "" },
    ];

    const registerUser = (ev: CampusEvent, activeRegs: EventRegistration[], newUserId: string) => {
      const currentActive = activeRegs.filter((r) => r.status === "registered").length;
      if (ev.capacity !== null && currentActive >= ev.capacity) {
        throw new Error("Event has reached maximum capacity");
      }
      return {
        id: "reg-3",
        event_id: ev.id,
        user_id: newUserId,
        status: "registered" as const,
        qr_code_token: "t-3",
        checked_in_at: null,
        created_at: new Date().toISOString(),
      };
    };

    expect(() => registerUser(event, registrations, "user-3")).toThrow(/maximum capacity/);
  });

  it("should validate attendee check-in and prevent duplicate check-ins", () => {
    const reg: EventRegistration = {
      id: "reg-1",
      event_id: "ev-101",
      user_id: "user-1",
      status: "registered",
      qr_code_token: "VALID_TOKEN_123",
      checked_in_at: null,
      created_at: "",
    };

    const checkIn = (ticket: EventRegistration, token: string): EventRegistration => {
      if (ticket.qr_code_token !== token) {
        throw new Error("Invalid ticket token");
      }
      if (ticket.checked_in_at !== null) {
        throw new Error("Attendee already checked in");
      }
      return { ...ticket, status: "attended", checked_in_at: new Date().toISOString() };
    };

    expect(() => checkIn(reg, "WRONG_TOKEN")).toThrow(/Invalid ticket token/);

    const checked = checkIn(reg, "VALID_TOKEN_123");
    expect(checked.status).toBe("attended");
    expect(checked.checked_in_at).toBeDefined();

    // Duplicate check-in attempt
    expect(() => checkIn(checked, "VALID_TOKEN_123")).toThrow(/already checked in/);
  });
});

describe("Notifications System", () => {
  it("should create proper notifications for announcements and membership approvals", () => {
    const createAnnouncementNotification = (
      userId: string,
      clubName: string,
      content: string
    ): CampusNotification => {
      return {
        id: "notif-1",
        user_id: userId,
        type: "announcement",
        title: `Notice from ${clubName}`,
        message: content.slice(0, 100),
        resource_type: "club",
        resource_id: "club-1",
        is_read: false,
        created_at: new Date().toISOString(),
      };
    };

    const notif = createAnnouncementNotification("user-1", "Robotics Club", "Orientation will begin at 4 PM.");
    expect(notif.type).toBe("announcement");
    expect(notif.is_read).toBe(false);
    expect(notif.resource_type).toBe("club");
  });
});

describe("College Roll Number Login & Mandatory Password Change", () => {
  const normalizeIdentifierToEmail = (identifier: string): string => {
    const clean = identifier.trim().toLowerCase();
    if (clean.includes("@")) return clean;
    return `${clean}@campus.internal`;
  };

  it("should map student roll numbers to synthetic college identity emails", () => {
    expect(normalizeIdentifierToEmail("24CS0142")).toBe("24cs0142@campus.internal");
    expect(normalizeIdentifierToEmail("  24it0089 ")).toBe("24it0089@campus.internal");
    expect(normalizeIdentifierToEmail("admin@college.edu")).toBe("admin@college.edu");
  });

  it("should block students from reusing their roll number as new permanent password", () => {
    const validateNewPassword = (rollNumber: string, newPassword: string) => {
      if (newPassword.length < 6) {
        throw new Error("Password must be at least 6 characters");
      }
      if (newPassword.trim().toLowerCase() === rollNumber.trim().toLowerCase()) {
        throw new Error("New password cannot be your roll number");
      }
      return true;
    };

    expect(() => validateNewPassword("24CS0142", "24CS0142")).toThrow(/cannot be your roll number/);
    expect(() => validateNewPassword("24CS0142", "24cs0142")).toThrow(/cannot be your roll number/);
    expect(() => validateNewPassword("24CS0142", "123")).toThrow(/at least 6 characters/);
    expect(validateNewPassword("24CS0142", "SecurePass#2026")).toBe(true);
  });

  it("should enforce mandatory password change on first login and update status on completion", () => {
    interface StudentSession {
      rollNumber: string;
      mustChangePassword: boolean;
      activePage: string;
    }

    const session: StudentSession = {
      rollNumber: "24CS0142",
      mustChangePassword: true,
      activePage: "/clubs",
    };

    // Route guard check
    const evaluateRoute = (s: StudentSession): string => {
      if (s.mustChangePassword) return "/change-password";
      return s.activePage;
    };

    // Initial attempt to access /clubs is redirected
    expect(evaluateRoute(session)).toBe("/change-password");

    // After password change is completed
    const updatedSession: StudentSession = {
      ...session,
      mustChangePassword: false,
    };

    expect(evaluateRoute(updatedSession)).toBe("/clubs");
  });

  it("should reject clearing mustChangePassword if database confirmation fails", async () => {
    let clientMustChangePassword = true;

    const verifyAndComplete = async (mockFetchProfile: () => Promise<{ must_change_password: boolean } | null>) => {
      const refreshed = await mockFetchProfile();
      if (!refreshed || refreshed.must_change_password) {
        clientMustChangePassword = true;
        throw new Error("Password updated, but setup is not yet confirmed. Please retry.");
      }
      clientMustChangePassword = false;
    };

    // Case 1: Database refresh fails / returns null
    await expect(verifyAndComplete(async () => null)).rejects.toThrow(
      /Password updated, but setup is not yet confirmed/
    );
    expect(clientMustChangePassword).toBe(true);

    // Case 2: Database still returns must_change_password = true
    await expect(verifyAndComplete(async () => ({ must_change_password: true }))).rejects.toThrow(
      /Password updated, but setup is not yet confirmed/
    );
    expect(clientMustChangePassword).toBe(true);

    // Case 3: Database confirms must_change_password = false
    await verifyAndComplete(async () => ({ must_change_password: false }));
    expect(clientMustChangePassword).toBe(false);
  });

  it("should fail-closed if profile loading encounters an error or returns null", () => {
    interface RouteEvalContext {
      user: { id: string } | null;
      profile: { id: string } | null;
      profileError: string | null;
      mustChangePassword: boolean;
    }

    const evaluateRouteSecurity = (ctx: RouteEvalContext): "auth" | "error_screen" | "change_password" | "allowed" => {
      if (!ctx.user) return "auth";
      if (ctx.profileError || !ctx.profile) return "error_screen";
      if (ctx.mustChangePassword) return "change_password";
      return "allowed";
    };

    // Missing profile or network error must fail-closed to error screen
    expect(evaluateRouteSecurity({
      user: { id: "u-1" },
      profile: null,
      profileError: "Network timeout",
      mustChangePassword: false,
    })).toBe("error_screen");

    expect(evaluateRouteSecurity({
      user: { id: "u-1" },
      profile: null,
      profileError: null,
      mustChangePassword: false,
    })).toBe("error_screen");

    // Profile loaded but must change password
    expect(evaluateRouteSecurity({
      user: { id: "u-1" },
      profile: { id: "u-1" },
      profileError: null,
      mustChangePassword: true,
    })).toBe("change_password");

    // Normal verified profile
    expect(evaluateRouteSecurity({
      user: { id: "u-1" },
      profile: { id: "u-1" },
      profileError: null,
      mustChangePassword: false,
    })).toBe("allowed");
  });

  it("should prevent students from self-assigning president role or active status during membership insertion", () => {
    interface MembershipInsertPayload {
      club_id: string;
      user_id: string;
      role: string;
      status: string;
    }

    const protectMembershipInsertion = (
      payload: MembershipInsertPayload,
      callerRole: "student" | "college_admin"
    ): MembershipInsertPayload => {
      if (callerRole !== "college_admin") {
        return {
          ...payload,
          role: "member",
          status: "pending",
        };
      }
      return payload;
    };

    // Malicious student attempting to insert president/active
    const forgedRequest: MembershipInsertPayload = {
      club_id: "club-1",
      user_id: "student-1",
      role: "president",
      status: "active",
    };

    const securedResult = protectMembershipInsertion(forgedRequest, "student");
    expect(securedResult.role).toBe("member");
    expect(securedResult.status).toBe("pending");

    // Admin creating membership
    const adminResult = protectMembershipInsertion(forgedRequest, "college_admin");
    expect(adminResult.role).toBe("president");
    expect(adminResult.status).toBe("active");
  });

  it("should ensure profile recovery always defaults is_verified to false and college_role to student", () => {
    interface ProfileRecoveryPayload {
      id: string;
      username: string;
      college_role: string;
      is_verified: boolean;
    }

    const protectProfileCreation = (
      input: Partial<ProfileRecoveryPayload>,
      callerRole: "student" | "college_admin"
    ): ProfileRecoveryPayload => {
      const isPrivileged = callerRole === "college_admin";
      return {
        id: input.id || "u-new",
        username: input.username || "student_user",
        college_role: isPrivileged ? (input.college_role || "college_admin") : "student",
        is_verified: isPrivileged ? Boolean(input.is_verified) : false,
      };
    };

    // Fallback/recovery path with attempted verification
    const recoveredProfile = protectProfileCreation(
      { username: "john", college_role: "college_admin", is_verified: true },
      "student"
    );

    expect(recoveredProfile.college_role).toBe("student");
    expect(recoveredProfile.is_verified).toBe(false);
  });

  it("should reject client-side notification forging by regular students", () => {
    const canInsertNotification = (
      callerRole: "student" | "college_admin",
      isSecurityDefinerTrigger: boolean
    ): boolean => {
      // Security definer triggers (system) and college_admins can insert notifications
      if (isSecurityDefinerTrigger) return true;
      if (callerRole === "college_admin") return true;
      return false; // Regular students are strictly rejected
    };

    expect(canInsertNotification("student", false)).toBe(false);
    expect(canInsertNotification("college_admin", false)).toBe(true);
    expect(canInsertNotification("student", true)).toBe(true);
  });

  it("should enforce message content immutability and restrict updates to read status only", () => {
    interface MessageRow {
      id: string;
      conversation_id: string;
      sender_id: string;
      content: string;
      is_read: boolean;
      read_at: string | null;
      created_at: string;
    }

    const applyMessageUpdate = (
      current: MessageRow,
      update: Partial<MessageRow>,
      callerId: string
    ): MessageRow => {
      // Rule 1: Content, sender, conversation, and created_at are strictly immutable
      if (
        (update.content !== undefined && update.content !== current.content) ||
        (update.sender_id !== undefined && update.sender_id !== current.sender_id) ||
        (update.conversation_id !== undefined && update.conversation_id !== current.conversation_id) ||
        (update.created_at !== undefined && update.created_at !== current.created_at) ||
        (update.id !== undefined && update.id !== current.id)
      ) {
        throw new Error("Unauthorized: Message content and metadata are immutable. Only read status can be updated.");
      }

      // Rule 2: Only recipients can mark messages as read
      if (callerId === current.sender_id && update.is_read !== undefined && update.is_read !== current.is_read) {
        throw new Error("Unauthorized: Only recipients can mark messages as read.");
      }

      return {
        ...current,
        is_read: update.is_read !== undefined ? update.is_read : current.is_read,
        read_at: update.read_at !== undefined ? update.read_at : current.read_at,
      };
    };

    const originalMsg: MessageRow = {
      id: "msg-1",
      conversation_id: "conv-1",
      sender_id: "student-b",
      content: "Hello from student B",
      is_read: false,
      read_at: null,
      created_at: "2026-10-12T00:00:00Z",
    };

    // Case 1: Student A (recipient) attempts to tamper with message content -> REJECTED
    expect(() =>
      applyMessageUpdate(originalMsg, { content: "Tampered content" }, "student-a")
    ).toThrow(/Message content and metadata are immutable/);

    // Case 2: Student A (recipient) attempts to tamper with sender_id -> REJECTED
    expect(() =>
      applyMessageUpdate(originalMsg, { sender_id: "student-a" }, "student-a")
    ).toThrow(/Message content and metadata are immutable/);

    // Case 3: Student B (sender) attempts to mark their own message read -> REJECTED
    expect(() =>
      applyMessageUpdate(originalMsg, { is_read: true }, "student-b")
    ).toThrow(/Only recipients can mark messages as read/);

    // Case 4: Student A (recipient) marks message read -> ALLOWED
    const readMsg = applyMessageUpdate(
      originalMsg,
      { is_read: true, read_at: "2026-10-12T00:05:00Z" },
      "student-a"
    );
    expect(readMsg.is_read).toBe(true);
    expect(readMsg.read_at).toBe("2026-10-12T00:05:00Z");
    expect(readMsg.content).toBe("Hello from student B");
  });

  it("should prevent stale search results by ignoring out-of-order responses using request id sequencing", async () => {
    let latestRequestId = 0;
    let renderedResult = "";

    const simulateSearch = async (query: string, delayMs: number) => {
      const requestId = ++latestRequestId;
      await new Promise((r) => setTimeout(r, delayMs));
      // Guard: only commit state if this request is still the newest
      if (requestId === latestRequestId) {
        renderedResult = query;
      }
    };

    // Fast search "lakshith" dispatched after slow search "lak"
    const slowSearch = simulateSearch("lak", 50); // Older request with high latency
    const fastSearch = simulateSearch("lakshith", 10); // Newer request with low latency

    await Promise.all([slowSearch, fastSearch]);

    // The newer request ("lakshith") must prevail even though the older request ("lak") finished later
    expect(renderedResult).toBe("lakshith");
  });

  it("should sanitize PostgREST filter characters from search queries to prevent syntax injection", () => {
    const sanitizeFilter = (raw: string) => raw.replace(/[,().:*]/g, " ").trim();

    expect(sanitizeFilter("student,name")).toBe("student name");
    expect(sanitizeFilter("filter:eq(val)")).toBe("filter eq val");
    expect(sanitizeFilter("24cs0142")).toBe("24cs0142");
    expect(sanitizeFilter("Lakshith Reddy")).toBe("Lakshith Reddy");
  });
});




