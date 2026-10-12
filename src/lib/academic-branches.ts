export interface BranchConfig {
  prefix: string;
  course: string;
  branchCode: string;
  displayName: string;
  admissionYear: number;
}

export const BRANCH_CONFIGS: BranchConfig[] = [
  {
    prefix: "25MVCSMR",
    course: "B.Tech",
    branchCode: "CSE-AIML",
    displayName: "Computer Science and Engineering (AI & ML)",
    admissionYear: 2025,
  },
  {
    prefix: "25MVCSER",
    course: "B.Tech",
    branchCode: "CSE",
    displayName: "Computer Science and Engineering",
    admissionYear: 2025,
  },
];

export function normalizeRollNumber(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidRollNumberFormat(value: string): boolean {
  const roll = normalizeRollNumber(value);
  return /^[A-Z0-9]{12}$/.test(roll);
}

export function findBranchForRollNumber(value: string): BranchConfig | null {
  const rollNumber = normalizeRollNumber(value);

  if (!isValidRollNumberFormat(rollNumber)) {
    return null;
  }

  return (
    BRANCH_CONFIGS.find((branch) => rollNumber.startsWith(branch.prefix)) ?? null
  );
}

export function validateRollNumber(value: string): {
  valid: boolean;
  rollNumber: string;
  branch: BranchConfig | null;
  error?: string;
} {
  const rollNumber = normalizeRollNumber(value);

  if (!rollNumber) {
    return { valid: false, rollNumber, branch: null, error: "Roll number is required" };
  }

  if (rollNumber.length !== 12) {
    return {
      valid: false,
      rollNumber,
      branch: null,
      error: `Roll number must be exactly 12 characters (entered ${rollNumber.length})`,
    };
  }

  if (!/^[A-Z0-9]{12}$/.test(rollNumber)) {
    return {
      valid: false,
      rollNumber,
      branch: null,
      error: "Roll number must only contain uppercase alphanumeric characters",
    };
  }

  const branch = findBranchForRollNumber(rollNumber);
  if (!branch) {
    return {
      valid: false,
      rollNumber,
      branch: null,
      error: "Roll number prefix is not configured in the verified academic directory",
    };
  }

  return { valid: true, rollNumber, branch };
}
