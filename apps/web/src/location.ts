import type { PostingLocation } from "@geohash-chat/shared";
export function freshPostingLocation(): Promise<PostingLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(
        new Error(
          "Location is unavailable. You can still browse, but posting requires location.",
        ),
      );
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        }),
      (error) =>
        reject(
          new Error(
            error.code === 1
              ? "Location permission is required to post. Allow location in your browser settings and try again."
              : error.code === 3
                ? "Finding your location timed out. Please try again."
                : "Could not determine your location. Please try again outdoors or on another device.",
          ),
        ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  });
}
