import { describe, it, expect } from "vitest";
import {
  StudentProfile,
  Club,
  ClubMembership,
  CampusEvent,
  EventRegistration,
  CampusNotification,
} from "../types/campus";
import { sanitizeSearchQuery } from "../lib/utils";
import {
  validateAndNormalizeUserProfile,
  resolveProfileFromSources,
} from "../lib/profileSecurity";

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

  it("should sanitize PostgREST filter characters and escape SQL wildcards from search queries", () => {
    // Tests comma, parentheses, colon, and asterisk stripping
    expect(sanitizeSearchQuery("student,name*(filter:eq)")).toBe("student name filter eq");
    // Tests SQL ILIKE wildcard character escaping for literal matching
    expect(sanitizeSearchQuery("100% attendance")).toBe("100\\% attendance");
    expect(sanitizeSearchQuery("john_doe")).toBe("john\\_doe");
    // Tests backslash escaping to prevent LIKE trailing-escape-character syntax errors
    expect(sanitizeSearchQuery("folder\\path\\file")).toBe("folder\\\\path\\\\file");
    expect(sanitizeSearchQuery("test\\")).toBe("test\\\\");
    expect(sanitizeSearchQuery("100\\% complete")).toBe("100\\\\\\% complete");
    expect(sanitizeSearchQuery("test_(with,parens\\and%wildcards*)")).toBe("test\\_ with parens\\\\and\\%wildcards");
    // Tests roll numbers and department with hyphens and dots
    expect(sanitizeSearchQuery("24CS-0142")).toBe("24CS-0142");
    expect(sanitizeSearchQuery("B.Tech CSE")).toBe("B.Tech CSE");
    // Tests collapsing repeated spaces
    expect(sanitizeSearchQuery("  Moku   Lakshith   Reddy  ")).toBe("Moku Lakshith Reddy");
  });

  it("should accurately enrich events with registration stats from get_event_registration_stats RPC map", () => {
    const rawEvents: CampusEvent[] = [
      {
        id: "ev-1",
        club_id: "club-1",
        title: "Hackathon",
        description: null,
        poster_url: null,
        venue: "Auditorium",
        start_time: "2026-10-20T10:00:00Z",
        end_time: null,
        capacity: 100,
        is_published: true,
        created_by: "user-1",
        created_at: "2026-10-01T00:00:00Z",
      },
      {
        id: "ev-2",
        club_id: "club-1",
        title: "Workshop",
        description: null,
        poster_url: null,
        venue: "Lab 3",
        start_time: "2026-10-22T14:00:00Z",
        end_time: null,
        capacity: 30,
        is_published: true,
        created_by: "user-1",
        created_at: "2026-10-01T00:00:00Z",
      },
    ];

    const statsData = [
      { event_id: "ev-1", registration_count: 87 },
      { event_id: "ev-2", registration_count: 30 },
    ];

    const registrationCounts = new Map<string, number>();
    for (const stat of statsData) {
      registrationCounts.set(stat.event_id, Number(stat.registration_count));
    }

    const enriched = rawEvents.map((ev) => ({
      ...ev,
      registration_count: registrationCounts.get(ev.id) || 0,
      is_full: ev.capacity !== null && (registrationCounts.get(ev.id) || 0) >= ev.capacity,
    }));

    expect(enriched[0].registration_count).toBe(87);
    expect(enriched[0].is_full).toBe(false);

    expect(enriched[1].registration_count).toBe(30);
    expect(enriched[1].is_full).toBe(true);
  });

  it("should correctly batch and associate latest messages to conversations without N+1 queries", () => {
    const convos = [
      { id: "c-1", last_message_at: "2026-10-12T10:00:00Z" },
      { id: "c-2", last_message_at: "2026-10-12T11:00:00Z" },
      { id: "c-3", last_message_at: "2026-10-12T09:00:00Z" },
    ];

    // Single batch of messages ordered by created_at DESC across conversations
    const batchMessages = [
      { conversation_id: "c-2", content: "See you at the robotics lab!", created_at: "2026-10-12T11:00:00Z" },
      { conversation_id: "c-2", content: "Are you coming?", created_at: "2026-10-12T10:50:00Z" },
      { conversation_id: "c-1", content: "Submitted the assignment", created_at: "2026-10-12T10:00:00Z" },
      { conversation_id: "c-1", content: "Did you finish question 3?", created_at: "2026-10-12T09:30:00Z" },
    ];

    const lastMessageMap = new Map<string, string>();
    for (const msg of batchMessages) {
      if (!lastMessageMap.has(msg.conversation_id)) {
        lastMessageMap.set(msg.conversation_id, msg.content);
      }
    }

    expect(lastMessageMap.get("c-1")).toBe("Submitted the assignment");
    expect(lastMessageMap.get("c-2")).toBe("See you at the robotics lab!");
    expect(lastMessageMap.get("c-3")).toBeUndefined();
  });

  it("should block non-admin users from altering verified student IDs", () => {
    const existingProfile: Partial<StudentProfile> = {
      id: "student-1",
      student_id: "24CS-0142",
      is_verified: true,
      college_role: "student",
    };

    const validateProfileUpdate = (
      current: typeof existingProfile,
      update: { student_id?: string },
      callerRole: string
    ) => {
      if (callerRole !== "college_admin" && current.is_verified) {
        if (update.student_id && update.student_id !== current.student_id) {
          throw new Error("Unauthorized: Verified student roll number cannot be modified by students");
        }
      }
      return { ...current, ...update };
    };

    // Student attempting to change roll number should fail
    expect(() =>
      validateProfileUpdate(existingProfile, { student_id: "24CS-9999" }, "student")
    ).toThrow("Unauthorized: Verified student roll number cannot be modified by students");

    // College admin can modify roll numbers
    const adminUpdated = validateProfileUpdate(
      existingProfile,
      { student_id: "24CS-0142-HONORS" },
      "college_admin"
    );
    expect(adminUpdated.student_id).toBe("24CS-0142-HONORS");

    // Unverified student can set their initial roll number
    const unverifiedProfile: Partial<StudentProfile> = {
      id: "student-2",
      student_id: "",
      is_verified: false,
      college_role: "student",
    };
    const studentUpdated = validateProfileUpdate(
      unverifiedProfile,
      { student_id: "25EC-0088" },
      "student"
    );
    expect(studentUpdated.student_id).toBe("25EC-0088");
  });

  it("should serialize like operations and prevent concurrent duplicate mutations", async () => {
    let inFlight = false;
    let likeCount = 5;
    let liked = false;

    const performLike = async () => {
      if (inFlight) return { skipped: true };
      inFlight = true;
      try {
        liked = !liked;
        likeCount += liked ? 1 : -1;
        // simulate async delay
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { skipped: false, liked, likeCount };
      } finally {
        inFlight = false;
      }
    };

    // Fire two like toggles concurrently
    const [first, second] = await Promise.all([performLike(), performLike()]);

    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(likeCount).toBe(6);
    expect(liked).toBe(true);
  });

  it("should deduplicate incoming realtime messages by message ID without adding duplicates", () => {
    interface Message {
      id: string;
      content: string;
    }

    const existing: Message[] = [
      { id: "m-1", content: "Hello campus!" },
      { id: "m-2", content: "Are you attending the hackathon?" },
    ];

    const deduplicateAppend = (prev: Message[], incoming: Message) => {
      if (prev.some((m) => m.id === incoming.id)) {
        return prev;
      }
      return [...prev, incoming];
    };

    // Duplicate message received via reconnect/race
    const updated1 = deduplicateAppend(existing, { id: "m-2", content: "Are you attending the hackathon?" });
    expect(updated1.length).toBe(2);

    // Truly new message received
    const updated2 = deduplicateAppend(existing, { id: "m-3", content: "Yes, I just registered." });
    expect(updated2.length).toBe(3);
    expect(updated2[2].id).toBe("m-3");
  });

  it("should distinguish failed registration stats (null) from confirmed zero attendance", () => {
    const rawEvents: CampusEvent[] = [
      {
        id: "ev-1",
        club_id: "club-1",
        title: "Coding Contest",
        description: null,
        poster_url: null,
        venue: "Hall A",
        start_time: "2026-10-25T10:00:00Z",
        end_time: null,
        capacity: 50,
        is_published: true,
        created_by: "user-1",
        created_at: "2026-10-01T00:00:00Z",
      },
    ];

    // Scenario A: RPC fails (e.g. network failure) -> statsLoaded = false
    const statsLoadedFailure = false;
    const registrationCounts = new Map<string, number>();

    const enrichedOnFailure = rawEvents.map((ev) => ({
      ...ev,
      registration_count: statsLoadedFailure ? (registrationCounts.get(ev.id) || 0) : null,
    }));
    expect(enrichedOnFailure[0].registration_count).toBeNull();

    // Scenario B: RPC succeeds with 0 registrations -> statsLoaded = true
    const statsLoadedSuccess = true;
    registrationCounts.set("ev-1", 0);

    const enrichedOnSuccess = rawEvents.map((ev) => ({
      ...ev,
      registration_count: statsLoadedSuccess ? (registrationCounts.get(ev.id) || 0) : null,
    }));
    expect(enrichedOnSuccess[0].registration_count).toBe(0);
  });
});

describe("Mandatory Password Change & Security Field Profile Resolution", () => {
  it("should fail closed and enforce mustChangePassword=true when RPC fails and fallback is missing must_change_password", () => {
    // Regression scenario: RPC fails; fallback query returns only public fields without must_change_password
    const rpcData = null;
    const rpcError = new Error("Function get_my_profile not found or RPC timeout");
    const incompleteFallbackData = {
      id: "std-100",
      username: "24cs0199",
      college_role: "student",
      is_verified: false,
      department: "CSE",
      year: "1st Year",
      branch_id: "b-01",
      // must_change_password is MISSING
    };

    const result = resolveProfileFromSources(rpcData, rpcError, incompleteFallbackData, null);

    // Incomplete profile must be rejected and mustChangePassword must default to true (fail-closed)
    expect(result.profile).toBeNull();
    expect(result.mustChangePassword).toBe(true);
    expect(result.error).toContain("missing security-critical fields");
  });

  it("should respect must_change_password=true when RPC fails but fallback provides must_change_password", () => {
    const rpcData = null;
    const rpcError = new Error("RPC timeout");
    const validFallbackData = {
      id: "std-101",
      username: "24cs0142",
      student_id: "24CS0142",
      college_role: "student",
      is_verified: true,
      must_change_password: true,
      department: "Computer Science",
      year: "1st Year",
      branch_id: "b-01",
    };

    const result = resolveProfileFromSources(rpcData, rpcError, validFallbackData, null);

    expect(result.profile).not.toBeNull();
    expect(result.profile?.username).toBe("24cs0142");
    expect(result.profile?.must_change_password).toBe(true);
    expect(result.mustChangePassword).toBe(true);
    expect(result.error).toBeNull();
  });

  it("should allow must_change_password=false ONLY when explicitly provided as boolean false", () => {
    const rpcData = null;
    const rpcError = new Error("RPC error");
    const onboardedFallbackData = {
      id: "std-102",
      username: "24cs0143",
      student_id: "24CS0143",
      college_role: "student",
      is_verified: true,
      must_change_password: false,
      department: "Computer Science",
      year: "2nd Year",
      branch_id: "b-01",
    };

    const result = resolveProfileFromSources(rpcData, rpcError, onboardedFallbackData, null);

    expect(result.profile).not.toBeNull();
    expect(result.profile?.must_change_password).toBe(false);
    expect(result.mustChangePassword).toBe(false);
    expect(result.error).toBeNull();
  });

  it("should reject profile and fail closed when role or username is invalid", () => {
    const invalidProfile1 = {
      id: "std-103",
      username: "   ", // whitespace only
      college_role: "student",
      is_verified: false,
      must_change_password: true,
    };
    expect(validateAndNormalizeUserProfile(invalidProfile1)).toBeNull();

    const invalidProfile2 = {
      id: "std-104",
      username: "attacker",
      college_role: "superuser", // unrecognized role
      is_verified: true,
      must_change_password: false,
    };
    expect(validateAndNormalizeUserProfile(invalidProfile2)).toBeNull();

    const result = resolveProfileFromSources(null, null, invalidProfile2, null);
    expect(result.profile).toBeNull();
    expect(result.mustChangePassword).toBe(true);
  });

  it("should successfully resolve profile when primary RPC succeeds with all security fields", () => {
    const rpcData = {
      id: "std-105",
      username: "24cs0144",
      student_id: "24CS0144",
      college_role: "student",
      is_verified: true,
      must_change_password: true,
      department: "CSE",
      year: "1st Year",
      branch_id: "b-02",
    };

    const result = resolveProfileFromSources(rpcData, null, null, null);

    expect(result.profile).not.toBeNull();
    expect(result.profile?.username).toBe("24cs0144");
    expect(result.mustChangePassword).toBe(true);
    expect(result.error).toBeNull();
  });

  it("regression: should throw error and prevent reaching normal application routes when auth succeeds but both profile-resolution paths fail", async () => {
    // 1. Supabase Auth succeeds and returns an authenticated user
    const mockAuthUser = { id: "user-123", email: "24cs0199@campus.internal" };

    // 2. Both profile resolution sources fail (RPC fails + fallback query fails)
    const rpcData = null;
    const rpcError = new Error("get_my_profile RPC failed: network timeout");
    const fallbackData = null;
    const fallbackError = new Error("fallback profiles table query failed: connection refused");

    const resolution = resolveProfileFromSources(rpcData, rpcError, fallbackData, fallbackError);
    expect(resolution.profile).toBeNull();
    expect(resolution.mustChangePassword).toBe(true);
    expect(resolution.error).toBeTruthy();

    // 3. Verify signIn contract: when profile resolution fails, it throws a clear error and NEVER returns false
    const simulateSignIn = async () => {
      if (!mockAuthUser) {
        throw new Error("Authentication failed: No user returned by authentication provider.");
      }
      const prof = resolution.profile;
      if (!prof) {
        const reason = resolution.error || "Account profile record could not be loaded or verified.";
        throw new Error(`Profile resolution failed (${reason}). Access to campus application routes is restricted.`);
      }
      if (!prof.is_verified) {
        throw new Error("Account directory verification is pending or incomplete. Access to campus application routes is restricted.");
      }
      return prof.must_change_password;
    };

    await expect(simulateSignIn()).rejects.toThrow("Profile resolution failed");
    await expect(simulateSignIn()).rejects.toThrow("Access to campus application routes is restricted.");

    // 4. Verify Route Guard Behavior: session exists with unresolved profile
    const evaluateRouteAccess = (sessionUser: any, profile: any, profileError: string | null, mustChange: boolean) => {
      if (!sessionUser) return "redirect:/auth";
      if (profileError || !profile) return "restricted:AuthErrorScreen";
      if (!profile.is_verified) return "restricted:UnverifiedScreen";
      if (mustChange) return "redirect:/change-password";
      return "allowed:NormalAppRoute";
    };

    const routeOutcome = evaluateRouteAccess(mockAuthUser, resolution.profile, resolution.error, resolution.mustChangePassword);
    expect(routeOutcome).toBe("restricted:AuthErrorScreen");
    expect(routeOutcome).not.toBe("allowed:NormalAppRoute");
    expect(routeOutcome).not.toBe("redirect:/");
  });

  it("regression: should restrict access when profile is loaded but directory verification is unverified", async () => {
    const mockAuthUser = { id: "user-unverified", email: "24cs0198@campus.internal" };
    const unverifiedProfile = {
      student_id: "24CS0198",
      username: "24cs0198",
      college_role: "student" as const,
      is_verified: false,
      must_change_password: false,
    };

    const evaluateRouteAccess = (sessionUser: any, profile: any, profileError: string | null, mustChange: boolean) => {
      if (!sessionUser) return "redirect:/auth";
      if (profileError || !profile) return "restricted:AuthErrorScreen";
      if (!profile.is_verified) return "restricted:UnverifiedScreen";
      if (mustChange) return "redirect:/change-password";
      return "allowed:NormalAppRoute";
    };

    const routeOutcome = evaluateRouteAccess(mockAuthUser, unverifiedProfile, null, unverifiedProfile.must_change_password);
    expect(routeOutcome).toBe("restricted:UnverifiedScreen");
    expect(routeOutcome).not.toBe("allowed:NormalAppRoute");
  });
});

describe("Live Test Suite Isolation & Teardown Guarantees", () => {
  it("should execute all teardown operations even when fixture setup fails halfway", async () => {
    const executedCleanups: string[] = [];
    const fixtureRegistry = {
      userIds: new Set<string>(["user-1", "user-2"]),
      clubIds: new Set<string>(["club-1"]),
      eventIds: new Set<string>(), // Event creation was interrupted
    };

    // Simulate test execution where setup throws after creating users and clubs
    const runSimulatedSuite = async () => {
      try {
        // Step 1: Users created
        // Step 2: Clubs created
        // Step 3: Event creation fails with network/constraint error
        throw new Error("Simulated setup failure during event insertion");
      } finally {
        // Multi-stage isolated cleanup matching test_staging_sessions_smoke & test_live_events_and_qr_checkin
        const tasks = [
          { name: "registrations", run: () => executedCleanups.push("registrations") },
          { name: "events", run: () => executedCleanups.push("events") },
          { name: "memberships", run: () => executedCleanups.push("memberships") },
          { name: "clubs", run: () => {
            fixtureRegistry.clubIds.clear();
            executedCleanups.push("clubs");
          }},
          { name: "profiles", run: () => executedCleanups.push("profiles") },
          { name: "auth_users", run: () => {
            fixtureRegistry.userIds.clear();
            executedCleanups.push("auth_users");
          }},
        ];

        for (const task of tasks) {
          try {
            task.run();
          } catch {
            // Ignored so subsequent tasks continue
          }
        }
      }
    };

    await expect(runSimulatedSuite()).rejects.toThrow("Simulated setup failure during event insertion");

    // Verify all cleanup stages executed regardless of the setup abort
    expect(executedCleanups).toEqual([
      "registrations",
      "events",
      "memberships",
      "clubs",
      "profiles",
      "auth_users",
    ]);
    expect(fixtureRegistry.userIds.size).toBe(0);
    expect(fixtureRegistry.clubIds.size).toBe(0);
  });

  it("should execute all teardown operations even when an assertion fails during test execution", async () => {
    const executedCleanups: string[] = [];
    const createdUsers = new Set<string>(["user-disposable-1"]);

    const runSimulatedTest = async () => {
      try {
        // Test assertion failure
        expect(1).toBe(2);
      } finally {
        // Teardown block
        try {
          executedCleanups.push("delete_profile");
        } catch (err) {
          void err;
        }
        try {
          createdUsers.delete("user-disposable-1");
          executedCleanups.push("delete_auth_user");
        } catch (err) {
          void err;
        }
      }
    };

    await expect(runSimulatedTest()).rejects.toThrow();
    expect(executedCleanups).toEqual(["delete_profile", "delete_auth_user"]);
    expect(createdUsers.size).toBe(0);
  });
});

describe("End-to-End Profile-Resolution Failure & Restricted Session State", () => {
  it("should enforce fail-closed restricted mode when auth succeeds but profile fails, verifying route lockdown, retry and sign-out", async () => {
    // 1. Simulation of Supabase authentication succeeding
    let authenticatedUser: { id: string; email: string } | null = {
      id: "u-student-test",
      email: "25mvcsmr9a1b@campus.internal",
    };
    let profileState: any = null;
    let profileErrorState: string | null = null;
    let mustChangePasswordState = false;

    // Database simulation controls
    let dbRpcFails = true;
    let dbFallbackFails = true;

    // Async profile resolution matching useAuth.tsx fetchProfile
    const fetchProfileSim = async () => {
      const rpcResult = dbRpcFails
        ? { data: null, error: new Error("RPC get_my_profile returned 500 internal error") }
        : { data: [{ id: authenticatedUser?.id, username: "25MVCSMR9A1B", student_id: "25MVCSMR9A1B", college_role: "student", is_verified: true, must_change_password: true }], error: null };

      let fallbackResult: any = { data: null, error: null };
      if (rpcResult.error || !rpcResult.data) {
        fallbackResult = dbFallbackFails
          ? { data: null, error: new Error("Fallback query to public.profiles failed: connection refused") }
          : { data: { id: authenticatedUser?.id, username: "25MVCSMR9A1B", student_id: "25MVCSMR9A1B", college_role: "student", is_verified: true, must_change_password: true }, error: null };
      }

      const resolution = resolveProfileFromSources(
        rpcResult.data,
        rpcResult.error,
        fallbackResult.data,
        fallbackResult.error
      );

      profileState = resolution.profile;
      profileErrorState = resolution.error;
      mustChangePasswordState = resolution.mustChangePassword;

      return resolution.profile;
    };

    // Step 1: Authentication succeeds
    expect(authenticatedUser).not.toBeNull();

    // Step 2 & 3: get_my_profile() fails and fallback also fails
    const initialProf = await fetchProfileSim();
    expect(initialProf).toBeNull();
    expect(profileErrorState).toContain("Database error fetching user profile");
    // Crucial fail-closed invariant: mustChangePassword MUST default to true
    expect(mustChangePasswordState).toBe(true);

    // Verify signIn() throws and rejects normal route navigation
    const simulateSignIn = async () => {
      const prof = await fetchProfileSim();
      if (!prof) {
        throw new Error(`Profile resolution failed (${profileErrorState}). Access to campus application routes is restricted.`);
      }
      return prof.must_change_password;
    };
    await expect(simulateSignIn()).rejects.toThrow("Profile resolution failed");

    // Route Guard Simulator modeling ProtectedRoute, ForcePasswordChangeRoute & AuthRoute
    const simulateRouteNavigation = (targetPath: string) => {
      if (!authenticatedUser) {
        return { rendered: "Navigate", destination: "/auth" };
      }
      if (profileErrorState || !profileState) {
        return { rendered: "AuthErrorScreen", error: profileErrorState };
      }
      if (!profileState.is_verified) {
        return { rendered: "AuthErrorScreen", error: "Directory verification unverified" };
      }
      if (targetPath === "/change-password") {
        if (!mustChangePasswordState) return { rendered: "Navigate", destination: "/" };
        return { rendered: "ChangePasswordPage" };
      }
      if (mustChangePasswordState) {
        return { rendered: "Navigate", destination: "/change-password" };
      }
      return { rendered: "ProtectedPage", path: targetPath };
    };

    // Step 4: The user CANNOT reach protected routes (yields AuthErrorScreen)
    expect(simulateRouteNavigation("/")).toEqual({
      rendered: "AuthErrorScreen",
      error: expect.stringContaining("Database error"),
    });
    expect(simulateRouteNavigation("/events")).toEqual({
      rendered: "AuthErrorScreen",
      error: expect.stringContaining("Database error"),
    });
    expect(simulateRouteNavigation("/feed")).toEqual({
      rendered: "AuthErrorScreen",
      error: expect.stringContaining("Database error"),
    });

    // Step 5: The user CANNOT bypass password change
    // Attempting to visit /change-password while profile is broken also halts at AuthErrorScreen
    expect(simulateRouteNavigation("/change-password")).toEqual({
      rendered: "AuthErrorScreen",
      error: expect.stringContaining("Database error"),
    });

    // Step 6a: Test Retry behavior
    // Retry while database is still failing keeps session restricted
    await fetchProfileSim();
    expect(simulateRouteNavigation("/")).toEqual({
      rendered: "AuthErrorScreen",
      error: expect.stringContaining("Database error"),
    });

    // When connection recovers and profile resolves with must_change_password=true
    dbRpcFails = false;
    dbFallbackFails = false;
    const recoveredProf = await fetchProfileSim();
    expect(recoveredProf).not.toBeNull();
    expect(profileErrorState).toBeNull();
    expect(mustChangePasswordState).toBe(true);

    // Protected route / now redirects to mandatory /change-password
    expect(simulateRouteNavigation("/")).toEqual({
      rendered: "Navigate",
      destination: "/change-password",
    });
    // /change-password page is now unlocked
    expect(simulateRouteNavigation("/change-password")).toEqual({
      rendered: "ChangePasswordPage",
    });

    // Once password is changed, mustChangePasswordState becomes false
    mustChangePasswordState = false;
    profileState.must_change_password = false;
    expect(simulateRouteNavigation("/")).toEqual({
      rendered: "ProtectedPage",
      path: "/",
    });

    // Step 6b: Test Sign-Out behavior
    const simulateSignOut = () => {
      authenticatedUser = null;
      profileState = null;
      profileErrorState = null;
      mustChangePasswordState = false;
    };

    simulateSignOut();
    // After sign-out, protected route redirects cleanly to /auth
    expect(simulateRouteNavigation("/")).toEqual({
      rendered: "Navigate",
      destination: "/auth",
    });
  });
});




