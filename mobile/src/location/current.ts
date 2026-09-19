import * as Location from 'expo-location';

export interface Coordinates {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  isApproximate: boolean;
  ageMs: number;
  source: 'current' | 'lastKnown';
}

const MAX_POSITION_AGE_MS = 60_000;
const APPROXIMATE_ACCURACY_METERS = 1_000;

function toCoordinates(position: Location.LocationObject, source: Coordinates['source']): Coordinates {
  const ageMs = Math.max(0, Date.now() - position.timestamp);
  if (ageMs > MAX_POSITION_AGE_MS) {
    throw new Error('Your location is stale. Move to an open area and try again.');
  }
  const accuracyMeters = position.coords.accuracy;
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracyMeters,
    isApproximate: typeof accuracyMeters === 'number' && accuracyMeters > APPROXIMATE_ACCURACY_METERS,
    ageMs,
    source,
  };
}

export async function getForegroundCoordinates(): Promise<Coordinates> {
  const servicesEnabled = await Location.hasServicesEnabledAsync();
  if (!servicesEnabled) {
    throw new Error('Location services are turned off. Enable location and try again.');
  }

  let permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== Location.PermissionStatus.GRANTED) {
    permission = await Location.requestForegroundPermissionsAsync();
  }
  if (permission.status !== Location.PermissionStatus.GRANTED) {
    throw new Error('Location permission is required to discover, create, or join a clan.');
  }

  try {
    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return toCoordinates(current, 'current');
  } catch (currentError) {
    const lastKnown = await Location.getLastKnownPositionAsync({ maxAge: MAX_POSITION_AGE_MS });
    if (!lastKnown) {
      throw currentError instanceof Error
        ? new Error(`Current location is unavailable. ${currentError.message}`)
        : new Error('Current location is unavailable. Try again in an open area.');
    }
    return toCoordinates(lastKnown, 'lastKnown');
  }
}
