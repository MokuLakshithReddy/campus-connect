# Architecture Decision Record: Legacy Social-Feed Routes Scope Resolution

## Context & Audit Finding
Issue #5 flagged that `/create` and `/post/:postId` routes still exist in `src/App.tsx`, and components (`CreatePost.tsx`, `PostDetail.tsx`, `PostCard.tsx`) continue to use the `posts`, `likes`, and `comments` tables. The audit requested a formal decision: either retain these as supported campus features or migrate/remove them.

## Decision: RETAIN & INTEGRATE AS "CAMPUS MOMENTS & MEDIA FEED"

We have formally decided to **retain and fully support** these routes and features as part of the core CampusConnect platform under the **Campus Moments / Student Media** domain.

### Rationale:
1. **Student Community Engagement**:
   - Beyond clubs and official events, students need a visual medium to share project demos, hackathon highlights, and campus life updates.
2. **Authoritative Database & Security Grounding**:
   - The `posts` table is already integrated into the PostgreSQL database schema with strict branch-isolation RLS policies (`Audience can view posts`, `Users upload own post media`).
   - Anti-spoofing database triggers (`trg_enforce_post_branch_ownership`) prevent cross-branch forgery on `posts`.
   - The CI security verification suite (`scripts/run_ci_postgres_integration_tests.cjs`) explicitly includes regression tests for post branch-filtering and anti-spoofing.
3. **Seamless Navigation & UX Integration**:
   - The `/explore` page serves as the discovery hub, presenting campus posts alongside student searches.
   - A prominent **"Share Post"** button in `/explore` routes directly to `/create`.
   - `/create` automatically applies the author's academic `branch_id`, uploads images to the secured `posts` storage bucket, and redirects back to `/explore`.
   - `/post/:postId` provides detailed post viewing with comments sheets and likes, with graceful back navigation to `/explore`.

## Scope Status
- **Status**: **RESOLVED / CLOSED**
- **Action Taken**: Formally designated as supported features; routes fully integrated with Explore; RLS policies and navigation validated.
