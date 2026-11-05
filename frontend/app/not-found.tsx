import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center px-4">
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-8 max-w-md w-full">
        <p className="text-5xl font-bold text-gray-600 mb-3">404</p>
        <h2 className="text-lg font-semibold text-gray-200 mb-2">Page not found</h2>
        <p className="text-sm text-gray-500 mb-6">
          The page you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link
          href="/"
          className="inline-block rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 transition-colors"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
