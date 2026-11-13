import { describe, it, expect } from "vitest";
import {
  encode,
  bounds,
  ancestors,
  chooseRoom,
  command,
  roomSchema,
} from "@geohash-chat/shared";
describe("geohash geometry", () => {
  it("matches a standard geohash vector", () => {
    expect(encode(42.6, -5.6, 5)).toBe("ezs42");
  });
  it("contains the encoded point at every precision and geographic boundary", () => {
    for (const [lat, lon] of [
      [37.7749, -122.4194],
      [0, 0],
      [-90, -180],
      [90, 180],
      [-33.86, 151.2],
    ])
      for (let n = 1; n <= 8; n++) {
        const b = bounds(encode(lat, lon, n));
        expect(lat).toBeGreaterThanOrEqual(b.south);
        expect(lat).toBeLessThanOrEqual(b.north);
        expect(lon).toBeGreaterThanOrEqual(b.west);
        expect(lon).toBeLessThanOrEqual(b.east);
      }
  });
  it("rejects malformed rooms and out-of-range locations", () => {
    for (const room of ["", "a", "9q8yy!!!!", "9q8yy1234", "ABC"])
      expect(roomSchema.safeParse(room).success).toBe(false);
    expect(() => encode(100, 0)).toThrow();
    expect(() => encode(NaN, 0)).toThrow();
  });
  it("chooses the deepest active ancestor, or a neighborhood when quiet", () => {
    expect(ancestors("9q8")).toEqual(["_", "9", "9q", "9q8"]);
    expect(chooseRoom("9q8yyk8y", { "9": 100, "9q8": 20, "9q8yy": 3 })).toBe(
      "9q8yy",
    );
    expect(chooseRoom("9q8yyk8y", {})).toBe("9q8yy");
  });
  it("handles commands and enforces zoom boundaries", () => {
    expect(command("/join dr5ru", "9q8yy")).toEqual({
      kind: "go",
      room: "dr5ru",
    });
    expect(command("/out", "9q8yy")).toEqual({ kind: "go", room: "9q8y" });
    expect(command("/in b", "9q8yy")).toEqual({ kind: "go", room: "9q8yyb" });
    expect(command("hi", "9q8yy")).toBeNull();
    expect(() => command("/out", "_")).toThrow();
    expect(() => command("/in b", "9q8yyk8y")).toThrow();
  });
});

it("supports the global room at precision zero and zooms across its boundary", () => {
  expect(roomSchema.parse("_")).toBe("_");
  for (const invalid of ["", "_c", "c_", "__"])
    expect(roomSchema.safeParse(invalid).success).toBe(false);
  expect(encode(37, -122, 0)).toBe("_");
  expect(bounds("_")).toEqual({ south: -90, north: 90, west: -180, east: 180 });
  expect(ancestors("_")).toEqual(["_"]);
  expect(command("/out", "c")).toEqual({ kind: "go", room: "_" });
  expect(command("/in c", "_")).toEqual({ kind: "go", room: "c" });
  expect(command("/join _", "c23")).toEqual({ kind: "go", room: "_" });
  expect(chooseRoom("c23nb62w", { _: 3 })).toBe("_");
  expect(chooseRoom("_", {})).toBe("_");
});
