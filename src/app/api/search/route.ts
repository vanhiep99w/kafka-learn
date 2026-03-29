import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';
import { NextResponse } from 'next/server';

export const dynamic = 'force-static';
export const revalidate = false;

function createSearchAPI() {
  const pages = source.getPages();
  if (pages.length === 0) {
    return null;
  }
  return createFromSource(source);
}

export async function GET() {
  const searchAPI = createSearchAPI();
  if (!searchAPI) {
    return NextResponse.json({});
  }
  const response = await searchAPI.staticGET();
  const data = await response.json();
  return NextResponse.json(data);
}
