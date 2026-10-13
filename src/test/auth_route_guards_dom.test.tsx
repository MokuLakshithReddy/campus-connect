import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute, ForcePasswordChangeRoute, AuthRoute } from "@/App";

// Mock Supabase client
const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn();
const mockSignOut = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: (...args: any[]) => mockGetSession(...args),
      onAuthStateChange: (...args: any[]) => mockOnAuthStateChange(...args),
      signOut: (...args: any[]) => mockSignOut(...args),
    },
    rpc: (...args: any[]) => mockRpc(...args),
    from: (...args: any[]) => mockFrom(...args),
  },
}));

function renderWithRouter(initialRoute = "/") {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <AuthProvider>
        <Routes>
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <div data-testid="protected-content">Protected Campus Content</div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/auth"
            element={
              <AuthRoute>
                <div data-testid="auth-page">Login Page</div>
              </AuthRoute>
            }
          />
          <Route
            path="/change-password"
            element={
              <ForcePasswordChangeRoute>
                <div data-testid="change-password-page">Change Password Screen</div>
              </ForcePasswordChangeRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("Auth Route Guards & Profile Resolution End-to-End DOM Tests", () => {
  let authCallback: ((event: string, session: any) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    authCallback = null;

    mockOnAuthStateChange.mockImplementation((cb) => {
      authCallback = cb;
      return {
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      };
    });

    mockSignOut.mockImplementation(async () => {
      if (authCallback) {
        authCallback("SIGNED_OUT", null);
      }
      return { error: null };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed to AuthErrorScreen when profile RPC and fallback query both fail", async () => {
    const mockUser = { id: "user-test-1", email: "25mvcsmr0001@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // Primary RPC fails
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "RPC get_my_profile returned 500 internal server error" },
    });

    // Fallback profiles query also fails
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "Profiles table database unreachable" },
          }),
        }),
      }),
    });

    renderWithRouter("/");

    // AuthErrorScreen must be rendered with fail-closed message
    await waitFor(() => {
      expect(screen.getByText("Profile Access Restricted")).toBeInTheDocument();
    });

    expect(screen.getByText(/We could not verify your student profile/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry Connection/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign Out/i })).toBeInTheDocument();

    // Sensitive protected route content must NOT be revealed
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
  });

  it("successfully recovers and renders protected route when fallback RPC succeeds", async () => {
    const mockUser = { id: "user-test-2", email: "25mvcsmr0002@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // Primary get_my_profile RPC fails, but fallback RPC get_my_profile_fallback succeeds
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "get_my_profile") {
        return Promise.resolve({ data: null, error: { message: "Primary RPC timeout" } });
      }
      if (rpcName === "get_my_profile_fallback") {
        return Promise.resolve({
          data: {
            id: "user-test-2",
            username: "25MVCSMR0002",
            college_role: "student",
            is_verified: true,
            department: "Computer Science",
            year: "1st Year",
            branch_id: "b-cs-aiml",
            must_change_password: false,
            student_id: "25MVCSMR0002",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderWithRouter("/");

    // Fallback RPC should grant access to protected route
    await waitFor(() => {
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });

    expect(screen.queryByText("Profile Access Restricted")).not.toBeInTheDocument();
  });

  it("successfully recovers through my_profile view when both primary and fallback RPCs fail", async () => {
    const mockUser = { id: "user-test-2b", email: "25mvcsmr002b@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // Both RPCs fail
    mockRpc.mockImplementation((rpcName: string) => {
      return Promise.resolve({ data: null, error: { message: `RPC ${rpcName} unavailable` } });
    });

    // View query to my_profile succeeds
    mockFrom.mockImplementation((tableOrView: string) => {
      if (tableOrView === "my_profile") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: "user-test-2b",
                  username: "25MVCSMR002B",
                  college_role: "student",
                  is_verified: true,
                  department: "Computer Science",
                  year: "1st Year",
                  branch_id: "b-cs-aiml",
                  must_change_password: false,
                  student_id: "25MVCSMR002B",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) };
    });

    renderWithRouter("/");

    // my_profile view grants access
    await waitFor(() => {
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
    expect(screen.queryByText("Profile Access Restricted")).not.toBeInTheDocument();
  });

  it("fails closed when fallback query returns incomplete or corrupted profile fields", async () => {
    const mockUser = { id: "user-test-3", email: "25mvcsmr0003@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // RPC fails
    mockRpc.mockResolvedValue({ data: null, error: { message: "RPC offline" } });

    // Fallback query returns missing college_role and invalid username
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: "user-test-3",
              username: "", // missing / invalid
              college_role: null, // missing college_role
              is_verified: true,
            },
            error: null,
          }),
        }),
      }),
    });

    renderWithRouter("/");

    // Incomplete fields must cause validateAndNormalizeUserProfile to fail closed
    await waitFor(() => {
      expect(screen.getByText("Profile Access Restricted")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
  });

  it("restores active session with valid profile and displays protected content directly", async () => {
    const mockUser = { id: "user-test-4", email: "25mvcsmr0004@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // RPC succeeds on first try
    mockRpc.mockResolvedValue({
      data: {
        id: "user-test-4",
        username: "25MVCSMR0004",
        college_role: "student",
        is_verified: true,
        department: "Computer Science",
        year: "1st Year",
        branch_id: "b-cs-aiml",
        must_change_password: false,
        student_id: "25MVCSMR0004",
      },
      error: null,
    });

    renderWithRouter("/");

    await waitFor(() => {
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
  });

  it("allows user to retry profile connection and recovers once backend is available", async () => {
    const mockUser = { id: "user-test-5", email: "25mvcsmr0005@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // Initial attempt: Both RPC and fallback fail
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Temporary network interruption" },
    });
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "Database starting up" },
          }),
        }),
      }),
    });

    renderWithRouter("/");

    await waitFor(() => {
      expect(screen.getByText("Profile Access Restricted")).toBeInTheDocument();
    });

    // Mock subsequent retry to succeed via get_my_profile RPC
    mockRpc.mockResolvedValue({
      data: {
        id: "user-test-5",
        username: "25MVCSMR0005",
        college_role: "student",
        is_verified: true,
        department: "Computer Science",
        year: "1st Year",
        branch_id: "b-cs-aiml",
        must_change_password: false,
        student_id: "25MVCSMR0005",
      },
      error: null,
    });

    const retryBtn = screen.getByRole("button", { name: /Retry Connection/i });
    fireEvent.click(retryBtn);

    // After retry, screen transitions to protected content
    await waitFor(() => {
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
    expect(screen.queryByText("Profile Access Restricted")).not.toBeInTheDocument();
  });

  it("executes sign out from AuthErrorScreen and returns to login route", async () => {
    const mockUser = { id: "user-test-6", email: "25mvcsmr0006@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "Access forbidden" },
    });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "Profiles RLS rejected query" },
          }),
        }),
      }),
    });

    renderWithRouter("/");

    await waitFor(() => {
      expect(screen.getByText("Profile Access Restricted")).toBeInTheDocument();
    });

    const signOutBtn = screen.getByRole("button", { name: /Sign Out/i });
    fireEvent.click(signOutBtn);

    expect(mockSignOut).toHaveBeenCalled();

    // After sign-out, unauthenticated user is navigated to /auth
    await waitFor(() => {
      expect(screen.getByTestId("auth-page")).toBeInTheDocument();
    });
  });

  it("enforces mandatory password-change routing when must_change_password is true", async () => {
    const mockUser = { id: "user-test-7", email: "25mvcsmr0007@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // Profile loaded but must_change_password = true
    mockRpc.mockResolvedValue({
      data: {
        id: "user-test-7",
        username: "25MVCSMR0007",
        college_role: "student",
        is_verified: true,
        department: "Computer Science",
        year: "1st Year",
        branch_id: "b-cs-aiml",
        must_change_password: true,
        student_id: "25MVCSMR0007",
      },
      error: null,
    });

    // 1. Attempting to visit "/" should redirect to "/change-password"
    const { unmount } = renderWithRouter("/");

    await waitFor(() => {
      expect(screen.getByTestId("change-password-page")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
    unmount();

    // 2. Directly visiting "/change-password" allows viewing the change password screen
    const { unmount: unmount2 } = renderWithRouter("/change-password");
    await waitFor(() => {
      expect(screen.getByTestId("change-password-page")).toBeInTheDocument();
    });
    unmount2();

    // 3. Attempting to visit "/auth" redirects to "/change-password"
    renderWithRouter("/auth");
    await waitFor(() => {
      expect(screen.getByTestId("change-password-page")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("auth-page")).not.toBeInTheDocument();
  });

  it("redirects away from change-password screen if user has already changed password", async () => {
    const mockUser = { id: "user-test-8", email: "25mvcsmr0008@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // Profile with must_change_password = false
    mockRpc.mockResolvedValue({
      data: {
        id: "user-test-8",
        username: "25MVCSMR0008",
        college_role: "student",
        is_verified: true,
        department: "Computer Science",
        year: "1st Year",
        branch_id: "b-cs-aiml",
        must_change_password: false,
        student_id: "25MVCSMR0008",
      },
      error: null,
    });

    // Visiting "/change-password" when not required should redirect to "/"
    renderWithRouter("/change-password");

    await waitFor(() => {
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("change-password-page")).not.toBeInTheDocument();
  });

  it("blocks unverified accounts from entering campus routes", async () => {
    const mockUser = { id: "user-test-9", email: "25mvcsmr0009@campus.internal" };
    const mockSession = { user: mockUser, access_token: "mock-token" };

    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    // Profile loaded but is_verified = false
    mockRpc.mockResolvedValue({
      data: {
        id: "user-test-9",
        username: "25MVCSMR0009",
        college_role: "student",
        is_verified: false,
        department: "Computer Science",
        year: "1st Year",
        branch_id: "b-cs-aiml",
        must_change_password: false,
        student_id: "25MVCSMR0009",
      },
      error: null,
    });

    renderWithRouter("/");

    await waitFor(() => {
      expect(screen.getByText("Profile Access Restricted")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Your account directory verification is pending or incomplete/i)
    ).toBeInTheDocument();
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
  });
});
