import { NextResponse } from "next/server";
import { getServerSyncPreset } from "@/lib/sync/serverPreset";

// The middleware already requires the access session cookie and a request
// proof for /api/sync, so only signed-in clients reach this handler.
export async function GET() {
  return NextResponse.json(await getServerSyncPreset(), {
    headers: { "Cache-Control": "no-store" },
  });
}
