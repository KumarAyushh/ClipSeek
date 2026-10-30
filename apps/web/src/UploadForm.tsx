// Upload form: pick a file (+ optional title) → POST /videos.
// The API answers once the file is saved, made faststart and probed (can take a few seconds
// for a big file), with status "processing". The workers then run in the background; App
// polls the video list to see the status change to ready / failed.
import { type FormEvent, useRef, useState } from "react";
import { uploadVideo } from "./api";

export function UploadForm({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A file <input> can't be cleared through React state (its value is read-only for security),
  // so after an upload we reset the whole <form> through this ref instead.
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); // stop the browser's own form submit (a full page reload)
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadVideo(file, title);
      formRef.current?.reset();
      setFile(null);
      setTitle("");
      onUploaded(); // App reloads the list → the new video shows up as "processing"
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <input
        type="file"
        accept="video/*"
        // files is a FileList (or null); we only allow one file
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-sm"
      />
      <input
        type="text"
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="rounded border px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={!file || uploading}
        className="rounded bg-gray-900 px-3 py-1 text-sm text-white disabled:opacity-40"
      >
        {uploading ? "Uploading…" : "Upload"}
      </button>
      {error && <p className="w-full text-sm text-red-600">Upload failed: {error}</p>}
    </form>
  );
}
