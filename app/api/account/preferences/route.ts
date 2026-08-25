import { apiErrorResponse, ApiError, privateJson, readJsonObject, requireProfileUser, requireSameOrigin } from '@/app/lib/api';
import { markets } from '@/app/markets';
import { getAccountPreferences, updateAccountPreferences, type AccountPreferences } from '@/db/account';

const MARKET_IDS = new Set(markets.map((market) => market.id));
const CHART_INTERVALS = new Set(['1', '5', '15', '30', '60', '240', 'D']);
const MAX_FAVORITES = 50;

function parsePreferences(value: Record<string, unknown>): AccountPreferences {
  const keys = Object.keys(value);
  const supportedKeys = new Set(['defaultMarketId', 'chartInterval', 'reduceMotion', 'favoriteMarkets']);
  if (keys.some((key) => !supportedKeys.has(key))) {
    throw new ApiError(400, 'UNSUPPORTED_FIELD', 'The preferences payload contains an unsupported field.');
  }

  if (typeof value.defaultMarketId !== 'string' || !MARKET_IDS.has(value.defaultMarketId)) {
    throw new ApiError(400, 'INVALID_MARKET', 'Choose a market from the current Aventa market catalog.');
  }
  if (typeof value.chartInterval !== 'string' || !CHART_INTERVALS.has(value.chartInterval)) {
    throw new ApiError(400, 'INVALID_CHART_INTERVAL', 'Choose a supported chart interval.');
  }
  if (typeof value.reduceMotion !== 'boolean') {
    throw new ApiError(400, 'INVALID_REDUCE_MOTION', 'reduceMotion must be a boolean.');
  }
  if (!Array.isArray(value.favoriteMarkets) || value.favoriteMarkets.length > MAX_FAVORITES) {
    throw new ApiError(400, 'INVALID_FAVORITES', `favoriteMarkets must contain no more than ${MAX_FAVORITES} markets.`);
  }

  const favoriteMarkets: string[] = [];
  const seen = new Set<string>();
  for (const marketId of value.favoriteMarkets) {
    if (typeof marketId !== 'string' || !MARKET_IDS.has(marketId)) {
      throw new ApiError(400, 'INVALID_FAVORITE_MARKET', 'Every favorite must be in the current Aventa market catalog.');
    }
    if (!seen.has(marketId)) {
      seen.add(marketId);
      favoriteMarkets.push(marketId);
    }
  }

  return {
    defaultMarketId: value.defaultMarketId,
    chartInterval: value.chartInterval,
    reduceMotion: value.reduceMotion,
    favoriteMarkets,
  };
}

export async function GET(request: Request) {
  try {
    const { user } = await requireProfileUser(request);
    return privateJson({ preferences: await getAccountPreferences(user.id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const { user } = await requireProfileUser(request);
    const preferences = parsePreferences(await readJsonObject(request));
    return privateJson({ preferences: await updateAccountPreferences(user.id, preferences) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
