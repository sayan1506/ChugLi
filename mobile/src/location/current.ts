import * as Location from 'expo-location';

export interface Coordinates {
  lat: number;
  lng: number;
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
    throw new Error('Location permission is required to create or join a clan.');
  }

  const position = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });

  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
  };
}
