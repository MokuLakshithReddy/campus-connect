import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ImagePlus, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { motion } from "framer-motion";

const CreatePost = () => {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(false);

  const revokePreview = () => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
  };

  // Cleanup on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      revokePreview();
    };
  }, []);

  const handleClearFile = () => {
    revokePreview();
    setFile(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;

    if (!f.type.startsWith("image/")) {
      toast.error("Please select a valid image file");
      return;
    }

    if (f.size > 10 * 1024 * 1024) {
      toast.error("Image file size must be less than 10MB");
      return;
    }

    // Revoke previous preview URL before allocating a new one
    revokePreview();

    const objUrl = URL.createObjectURL(f);
    previewRef.current = objUrl;
    setFile(f);
    setPreview(objUrl);
  };

  const handleSubmit = async () => {
    if (!user || !file) return;
    setLoading(true);
    let uploadedPath: string | null = null;

    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${user.id}/${Date.now()}.${ext}`;
      uploadedPath = path;

      const { error: uploadError } = await supabase.storage.from("posts").upload(path, file);
      if (uploadError) throw uploadError;

      const { error: insertError } = await supabase.from("posts").insert({
        user_id: user.id,
        image_url: path,
        caption: caption.trim(),
        branch_id: profile?.branch_id || null,
      } as any);
      if (insertError) {
        // Rollback uploaded storage file if database record insertion fails
        try {
          await supabase.storage.from("posts").remove([path]);
        } catch (rollbackErr) {
          console.error("Storage rollback failed:", rollbackErr);
        }
        throw insertError;
      }

      revokePreview();
      toast.success("Post shared!");
      navigate("/explore");
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to create post");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppLayout>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b bg-background/95 backdrop-blur px-4 py-3">
        <button onClick={() => navigate(-1)} className="text-sm font-medium">
          Cancel
        </button>
        <h1 className="text-base font-semibold">New Post</h1>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!file || loading}
          className="rounded-lg"
        >
          {loading ? "..." : "Share"}
        </Button>
      </header>

      <div className="p-4">
        {!preview ? (
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => fileRef.current?.click()}
            className="flex aspect-square w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-secondary/50 transition-colors hover:bg-secondary"
          >
            <ImagePlus className="h-12 w-12 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium text-muted-foreground">Tap to select a photo</p>
          </motion.button>
        ) : (
          <div className="relative">
            <img src={preview} alt="Preview" className="w-full rounded-2xl object-cover" />
            <button
              onClick={handleClearFile}
              className="absolute right-3 top-3 rounded-full bg-foreground/70 p-1.5 text-background"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <Textarea
          placeholder="Write a caption..."
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          className="mt-4 min-h-[100px] resize-none rounded-xl border-0 bg-secondary"
        />
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={handleFile}
        className="hidden"
      />
    </AppLayout>
  );
};

export default CreatePost;
