import { useState, useEffect, useRef } from "react";
import { Heart, MessageCircle, Send } from "lucide-react";
import PostActions from "@/components/PostActions";
import SharePostDialog from "@/components/SharePostDialog";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { getAvatarUrl, getPostImageUrl } from "@/lib/supabase-helpers";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

interface PostCardProps {
  post: {
    id: string;
    user_id: string;
    image_url: string;
    caption: string;
    created_at: string;
    profiles: { username: string; avatar_url: string };
    likes: { user_id: string }[];
    comments: { id: string }[];
  };
  onLikeToggle?: () => void;
  onCommentOpen?: (postId: string) => void;
}

const PostCard = ({ post, onLikeToggle, onCommentOpen }: PostCardProps) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isLiked = post.likes?.some((l) => l.user_id === user?.id) ?? false;
  const [liked, setLiked] = useState(isLiked);
  const [likeCount, setLikeCount] = useState(post.likes?.length ?? 0);
  const [showHeart, setShowHeart] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [likeLoading, setLikeLoading] = useState(false);
  const isLikingRef = useRef(false);

  useEffect(() => {
    setLiked(isLiked);
    setLikeCount(post.likes?.length ?? 0);
  }, [post.likes, isLiked]);

  const toggleLike = async () => {
    if (!user || isLikingRef.current) return;
    isLikingRef.current = true;
    setLikeLoading(true);

    const targetLiked = !liked;
    setLiked(targetLiked);
    setLikeCount((c) => Math.max(0, c + (targetLiked ? 1 : -1)));

    try {
      if (targetLiked) {
        const { error } = await supabase.from("likes").insert({ user_id: user.id, post_id: post.id });
        if (error) {
          // If code 23505 (unique key constraint), record already existed - keep liked state
          if (error.code === "23505") {
            setLiked(true);
          } else {
            setLiked(false);
            setLikeCount((c) => Math.max(0, c - 1));
            toast.error("Could not like post");
            return;
          }
        }
      } else {
        const { error } = await supabase.from("likes").delete().eq("user_id", user.id).eq("post_id", post.id);
        if (error) {
          setLiked(true);
          setLikeCount((c) => c + 1);
          toast.error("Could not unlike post");
          return;
        }
      }
      onLikeToggle?.();
    } catch (err: unknown) {
      console.error("Like mutation error:", err);
    } finally {
      isLikingRef.current = false;
      setLikeLoading(false);
    }
  };

  const handleDoubleClick = () => {
    if (!liked && !isLikingRef.current) toggleLike();
    setShowHeart(true);
    setTimeout(() => setShowHeart(false), 800);
  };

  const avatarUrl = getAvatarUrl(post.profiles?.avatar_url);

  return (
    <article className="border-b">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => navigate(`/profile/${post.user_id}`)}
          className="flex items-center gap-3"
        >
          <div className="h-8 w-8 overflow-hidden rounded-full bg-secondary">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs font-semibold text-muted-foreground">
                {post.profiles?.username?.[0]?.toUpperCase()}
              </div>
            )}
          </div>
          <span className="text-sm font-semibold">{post.profiles?.username}</span>
        </button>
        <PostActions
          postId={post.id}
          postUserId={post.user_id}
          imageUrl={post.image_url}
          onDeleted={onLikeToggle}
        />
      </div>

      {/* Image */}
      <div className="relative aspect-square bg-secondary" onDoubleClick={handleDoubleClick}>
        <img
          src={getPostImageUrl(post.image_url)}
          alt={post.caption}
          className="h-full w-full object-cover"
          loading="lazy"
        />
        <AnimatePresence>
          {showHeart && (
            <motion.div
              initial={{ scale: 0, opacity: 1 }}
              animate={{ scale: 1.2, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              <Heart className="h-20 w-20 fill-white text-white drop-shadow-lg" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Actions */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-4">
          <button onClick={toggleLike} disabled={likeLoading} aria-label="Like post">
            <Heart
              className={cn(
                "h-6 w-6 transition-colors",
                liked ? "fill-red-500 text-red-500" : "text-foreground"
              )}
            />
          </button>
          <button onClick={() => onCommentOpen?.(post.id)}>
            <MessageCircle className="h-6 w-6" />
          </button>
          <button onClick={() => setShareOpen(true)}>
            <Send className="h-6 w-6" />
          </button>
        </div>
        <p className="mt-2 text-sm font-semibold">{likeCount.toLocaleString()} likes</p>
        {post.caption && (
          <p className="mt-1 text-sm">
            <span className="font-semibold">{post.profiles?.username}</span>{" "}
            {post.caption}
          </p>
        )}
        {(post.comments?.length ?? 0) > 0 && (
          <button
            onClick={() => onCommentOpen?.(post.id)}
            className="mt-1 text-sm text-muted-foreground"
          >
            View all {post.comments.length} comments
          </button>
        )}
        <p className="mt-1 text-[10px] uppercase text-muted-foreground">
          {formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}
        </p>
      </div>
      <SharePostDialog postId={post.id} open={shareOpen} onOpenChange={setShareOpen} />
    </article>
  );
};

export default PostCard;
