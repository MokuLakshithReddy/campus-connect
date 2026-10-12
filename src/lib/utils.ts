import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Sanitizes user search query for PostgREST .or() filter expressions.
 * - Strips PostgREST reserved delimiter characters (commas, parentheses, colons) that would corrupt filter structure.
 * - Collapses consecutive whitespace into single spaces.
 * - Preserves academic abbreviations, hyphens, and roll numbers (e.g. "24CS-0142", "B.Tech CSE").
 */
export function sanitizeSearchQuery(query: string): string {
  if (!query) return "";
  return query
    .replace(/[,():]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
