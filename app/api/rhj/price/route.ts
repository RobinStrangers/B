const PRICE_ENDPOINT = 'https://api.robinhood.com/rhj/prices';
const SYMBOL_PATTERN = /^[A-Z0-9.]{1,12}$/;

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get('symbol')?.toUpperCase() ?? '';

  if (!SYMBOL_PATTERN.test(symbol)) {
    return Response.json({ error: 'A valid asset symbol is required.' }, { status: 400 });
  }

  try {
    const response = await fetch(`${PRICE_ENDPOINT}/${encodeURIComponent(symbol)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) {
      return Response.json(
        { error: 'The live Stock Token quote is unavailable.' },
        { status: response.status === 404 ? 404 : 502 },
      );
    }

    const payload = await response.json();
    return Response.json(payload, {
      headers: { 'Cache-Control': 'public, max-age=15, s-maxage=15, stale-while-revalidate=15' },
    });
  } catch {
    return Response.json(
      { error: 'The live Stock Token quote could not be reached.' },
      { status: 502 },
    );
  }
}
