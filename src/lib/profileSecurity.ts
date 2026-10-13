export interface UserProfile {
  student_id: string | null;
  username: string;
  college_role: "student" | "faculty" | "college_admin";
  is_verified: boolean;
  must_change_password: boolean;
  department?: string | null;
  year?: string | null;
  branch_id?: string | null;
}

export interface ProfileResolutionResult {
  profile: UserProfile | null;
  mustChangePassword: boolean;
  error: string | null;
}

/**
 * Validates that an incoming profile record contains all security-critical fields
 * with expected types before allowing protected application access.
 *
 * CRITICAL SECURITY INVARIANT:
 * never infer must_change_password = false from undefined, null, or missing fields.
 */
export function validateAndNormalizeUserProfile(data: any): UserProfile | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const validRoles = ["student", "faculty", "college_admin"];
  const hasValidUsername = typeof data.username === "string" && data.username.trim().length > 0;
  const hasValidRole = typeof data.college_role === "string" && validRoles.includes(data.college_role);
  const hasValidVerified = typeof data.is_verified === "boolean";
  // Security critical: must_change_password must be strictly boolean, never undefined or inferred false
  const hasValidMustChangePassword = typeof data.must_change_password === "boolean";

  if (!hasValidUsername || !hasValidRole || !hasValidVerified || !hasValidMustChangePassword) {
    return null;
  }

  return {
    student_id: typeof data.student_id === "string" ? data.student_id : null,
    username: data.username,
    college_role: data.college_role as "student" | "faculty" | "college_admin",
    is_verified: data.is_verified,
    must_change_password: data.must_change_password,
    department: typeof data.department === "string" ? data.department : null,
    year: typeof data.year === "string" ? data.year : null,
    branch_id: typeof data.branch_id === "string" ? data.branch_id : null,
  };
}

/**
 * Resolves user profile from primary RPC (get_my_profile) with fail-closed fallback
 * to public.profiles table query.
 *
 * Enforces that:
 * 1. Failure of get_my_profile is treated as a profile-loading failure, not proof that the user completed password change.
 * 2. Missing must_change_password in fallback fails closed to mustChangePassword = true.
 * 3. All security-critical fields must be present and valid.
 */
export function resolveProfileFromSources(
  rpcData: any,
  rpcError: any,
  fallbackData: any,
  fallbackError: any
): ProfileResolutionResult {
  const primaryRow = Array.isArray(rpcData) ? rpcData[0] : rpcData;

  // 1. If primary RPC succeeded and returned a record
  if (primaryRow && !rpcError) {
    const validated = validateAndNormalizeUserProfile(primaryRow);
    if (!validated) {
      return {
        profile: null,
        mustChangePassword: true, // Fail closed
        error: "Profile returned from server is missing security-critical fields. Access restricted.",
      };
    }
    return {
      profile: validated,
      mustChangePassword: validated.must_change_password,
      error: null,
    };
  }

  // 2. If primary RPC failed or returned empty, evaluate fallback
  if (fallbackError) {
    return {
      profile: null,
      mustChangePassword: true, // Fail closed
      error: `Database error fetching user profile (${fallbackError.message}). Please check network/connection.`,
    };
  }

  if (!fallbackData) {
    return {
      profile: null,
      mustChangePassword: true, // Fail closed
      error: "Account profile record not found. Please contact campus administration.",
    };
  }

  const validatedFallback = validateAndNormalizeUserProfile(fallbackData);
  if (!validatedFallback) {
    // If fallback query was missing must_change_password or other security fields, NEVER treat as false!
    return {
      profile: null,
      mustChangePassword: true, // Fail closed
      error: "Fallback profile is missing security-critical fields (including must_change_password). Access restricted.",
    };
  }

  return {
    profile: validatedFallback,
    mustChangePassword: validatedFallback.must_change_password,
    error: null,
  };
}
