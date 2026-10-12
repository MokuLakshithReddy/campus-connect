import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Sanitizes user search query for PostgREST .or() and .ilike() filter expressions.
 * - Strips PostgREST reserved delimiter characters (commas, parentheses, colons, asterisks) that would corrupt filter structure.
 * - Escapes SQL LIKE / ILIKE wildcard characters (% and _) so search terms match literally.
 * - Collapses consecutive whitespace into single spaces.
 * - Preserves roll numbers, academic abbreviations, hyphens, and apostrophes (e.g. "24CS-0142", "B.Tech CSE", "O'Connor").
 */
export function sanitizeSearchQuery(query: string): string {
  if (!query) return "";
  return query
    .replace(/[,():*]/g, " ")
    .replace(/[%_]/g, "\\$&")
    .replace(/\s+/g, " ")
    .trim();
}
