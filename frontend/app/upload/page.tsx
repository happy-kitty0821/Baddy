/**
 * Upload page — lets the user upload a new match video.
 */
import type { Metadata } from "next";
import UploadForm from "@/components/UploadForm/UploadForm";

export const metadata: Metadata = {
  title: "Upload Match — Badminton AI Coach",
};

export default function UploadPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Upload Match</h1>
        <p className="mt-1 text-sm text-gray-400">
          Upload a video to add it to your permanent match library.
          Processing happens in the background — you can close this page after
          the upload completes.
        </p>
      </div>

      <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
        <UploadForm />
      </div>
    </div>
  );
}
