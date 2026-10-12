import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import AppLayout from "@/components/AppLayout";
import { getAvatarUrl, getPostImageUrl } from "@/lib/supabase-helpers";
import { useNavigate } from "react-router-dom";
import { Search, User, Loader2, RefreshCw, AlertCircle, Filter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { sanitizeSearchQuery } from "@/lib/utils";
import { BRANCH_CONFIGS } from "@/lib/academic-branches";

interface ExplorePost {
  id: string;
  image_url: string;
  user_id: string;
  caption?: string | null;
  profiles: { username: string; department?: string | null } | null;
}

interface UserSearchResult {
  id: string;
  username: string;
  avatar_url: string | null;
  department?: string | null;
  student_id?: string | null;
}

const PAGE_SIZE = 18;

const Explore = () => {
  const [posts, setPosts] = useState<ExplorePost[]>([]);
  const [matchingUsers, setMatchingUsers] = useState<UserSearchResult[]>([]);
  const [search, setSearch] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("All");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const [loadingPosts, setLoadingPosts] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [errorPosts, setErrorPosts] = useState<string | null>(null);

  const navigate = useNavigate();
  const postRequestIdRef = useRef(0);
  const userRequestIdRef = useRef(0);

  // Database-backed paginated search for posts with stale-response protection
  const fetchPosts = useCallback(async (query: string, pageNum: number, branch: string, append = false) => {
    const requestId = ++postRequestIdRef.current;
    if (pageNum === 0) setLoadingPosts(true);
    else setLoadingMore(true);
    setErrorPosts(null);

    try {
      const from = pageNum * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let req = supabase
        .from("posts")
        .select("id, image_url, user_id, caption, profiles(username, department)", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);

      const sanitized = sanitizeSearchQuery(query);
      if (sanitized) {
        req = req.ilike("caption", `%${sanitized}%`);
      }

      if (branch !== "All") {
        req = req.ilike("caption", `%${branch}%`);
      }

      const { data, count, error } = await req;
      if (error) throw error;

      // Discard stale out-of-order responses
      if (requestId !== postRequestIdRef.current) return;

      const results = (data as unknown as ExplorePost[]) ?? [];
      setPosts((prev) => (append ? [...prev, ...results] : results));
      setHasMore(count !== null ? from + results.length < count : results.length === PAGE_SIZE);
    } catch (err: unknown) {
      if (requestId !== postRequestIdRef.current) return;
      console.error("Error loading explore posts:", err);
      const e = err as Error;
      setErrorPosts(e?.message || "Failed to load posts. Please try again.");
    } finally {
      if (requestId === postRequestIdRef.current) {
        setLoadingPosts(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // Database-backed search for student profiles with sanitization and race-condition guard
  const searchUsers = useCallback(async (query: string, branch: string) => {
    const requestId = ++userRequestIdRef.current;
    const sanitized = sanitizeSearchQuery(query);
    if (!sanitized && branch === "All") {
      setMatchingUsers([]);
      setLoadingUsers(false);
      return;
    }

    setLoadingUsers(true);
    try {
      let req = supabase
        .from("profiles")
        .select("id, username, avatar_url, department, student_id");

      if (sanitized) {
        req = req.or(`username.ilike.%${sanitized}%,student_id.ilike.%${sanitized}%,department.ilike.%${sanitized}%`);
      }

      if (branch !== "All") {
        req = req.ilike("department", `%${branch}%`);
      }

      const { data, error } = await req.limit(15);
      if (error) throw error;

      // Discard stale response if a newer search request was initiated
      if (requestId !== userRequestIdRef.current) return;
      setMatchingUsers(data ?? []);
    } catch (err) {
      if (requestId !== userRequestIdRef.current) return;
      console.error("Error searching users:", err);
      setMatchingUsers([]);
    } finally {
      if (requestId === userRequestIdRef.current) {
        setLoadingUsers(false);
      }
    }
  }, []);

  // Debounced search trigger
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(0);
      fetchPosts(search, 0, selectedBranch, false);
      searchUsers(search, selectedBranch);
    }, 350);

    return () => clearTimeout(timer);
  }, [search, selectedBranch, fetchPosts, searchUsers]);

  const handleLoadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchPosts(search, nextPage, selectedBranch, true);
  };

  return (
    <AppLayout>
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur px-4 py-3 border-b space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search students, roll numbers, or posts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 rounded-xl bg-secondary border-0 pl-10 pr-9"
          />
          {(loadingUsers || loadingPosts) && (search.trim() || selectedBranch !== "All") && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* Academic Branch Filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none text-xs">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider shrink-0 mr-0.5 flex items-center gap-1">
            <Filter className="h-3 w-3" /> Branch:
          </span>
          <button
            onClick={() => setSelectedBranch("All")}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors shrink-0 ${
              selectedBranch === "All"
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
            }`}
          >
            All Branches
          </button>
          {BRANCH_CONFIGS.map((b) => (
            <button
              key={b.branchCode}
              onClick={() => setSelectedBranch(b.branchCode)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors shrink-0 ${
                selectedBranch === b.branchCode
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
              }`}
            >
              {b.course} {b.branchCode}
            </button>
          ))}
        </div>
      </header>

      {/* Database Matching Users Quick List */}
      {search.trim() && (
        <div className="border-b px-4 py-2 space-y-1 bg-secondary/10">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
            Students {matchingUsers.length > 0 && `(${matchingUsers.length})`}
          </p>
          {loadingUsers ? (
            <div className="py-2 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Searching campus directory...
            </div>
          ) : matchingUsers.length === 0 ? (
            <p className="py-1.5 text-xs text-muted-foreground">No matching students found</p>
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-1 divide-y divide-border/20">
              {matchingUsers.map((u) => {
                const avatar = getAvatarUrl(u.avatar_url);
                return (
                  <button
                    key={u.id}
                    onClick={() => navigate(`/profile/${u.id}`)}
                    className="flex w-full items-center gap-2.5 py-2 px-2 rounded-lg hover:bg-secondary text-left transition-colors"
                  >
                    <div className="h-8 w-8 rounded-full bg-secondary overflow-hidden shrink-0 flex items-center justify-center">
                      {avatar ? (
                        <img src={avatar} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <User className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{u.username}</span>
                        {u.student_id && (
                          <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded font-mono text-muted-foreground">
                            {u.student_id}
                          </span>
                        )}
                      </div>
                      {u.department && (
                        <p className="text-[11px] text-muted-foreground truncate">{u.department}</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Posts Section */}
      <div className="p-4">
        {errorPosts ? (
          <div className="p-6 text-center rounded-xl bg-destructive/10 border border-destructive/20 my-4">
            <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
            <p className="text-sm font-medium text-destructive mb-3">{errorPosts}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchPosts(search, 0, selectedBranch, false)}
              className="gap-2"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : loadingPosts ? (
          <div className="grid grid-cols-3 gap-1">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="aspect-square bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : posts.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <Search className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm font-medium">No posts found</p>
            {search.trim() && (
              <p className="text-xs text-muted-foreground mt-1">
                Try searching with different keywords or student names
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-0.5">
              {posts.map((post) => (
                <button
                  key={post.id}
                  onClick={() => navigate(`/post/${post.id}`)}
                  className="aspect-square overflow-hidden bg-secondary relative group"
                >
                  <img
                    src={getPostImageUrl(post.image_url)}
                    alt={post.caption || "Campus post"}
                    className="h-full w-full object-cover transition-opacity group-hover:opacity-90"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>

            {hasMore && (
              <div className="mt-6 text-center">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="w-full sm:w-auto gap-2"
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading more posts...
                    </>
                  ) : (
                    "Load More Posts"
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
};

export default Explore;
