/**
 * Match detail page (server component).
 *
 * In Next.js 15, dynamic route params is a Promise.
 * This server component awaits it and passes the id to the client component.
 */
import MatchDetail from "./MatchDetail";

interface MatchPageProps {
  params: Promise<{ id: string }>;
}

export default async function MatchPage({ params }: MatchPageProps) {
  const { id } = await params;
  return <MatchDetail id={id} />;
}
