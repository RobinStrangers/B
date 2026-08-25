const ASSETS_ENDPOINT = 'https://api.robinhood.com/rhj/assets';

export async function GET() {
  try {
    const response = await fetch(ASSETS_ENDPOINT, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      return Response.json(
        { error: 'The Robinhood Stock Token asset registry is unavailable.' },
        { status: 502 },
      );
    }

    const payload = await response.json();
    return Response.json(payload, {
      headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' },
    });
  } catch {
    return Response.json(
      { error: 'The Robinhood Stock Token asset registry could not be reached.' },
      { status: 502 },
    );
  }
}
