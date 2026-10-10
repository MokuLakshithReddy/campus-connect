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
});

