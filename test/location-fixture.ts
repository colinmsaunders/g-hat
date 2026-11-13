import { bounds } from "@geochalk/shared";
export function locationFor(room: string) {
  const b = bounds(room);
  const latitude = (b.north + b.south) / 2,
    longitude = (b.east + b.west) / 2;
  const unit = (Math.PI * 6371008.8) / 180;
  return {
    latitude,
    longitude,
    accuracy:
      Math.min(
        (b.east - b.west) * unit * Math.cos((latitude * Math.PI) / 180),
        (b.north - b.south) * unit,
      ) / 3,
    timestamp: Date.now(),
  };
}
