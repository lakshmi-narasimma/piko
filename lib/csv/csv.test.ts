import { describe, expect, it } from "vitest";
import { csvSafe } from "./index";

describe("csvSafe", () => {
  it.each([
    ["=", '=HYPERLINK("http://evil")'],
    ["+", "+1+1"],
    ["-", "-2+3"],
    ["@", "@SUM(A1:A2)"],
    ["a tab", "\t=1+1"],
    ["a carriage return", "\r=1+1"],
  ])("prefixes a value starting with %s", (_name, value) => {
    expect(csvSafe(value)).toBe(`'${value}`);
  });

  it("leaves a safe value unchanged", () => {
    expect(csvSafe("campaign-researcher")).toBe("campaign-researcher");
    expect(csvSafe("")).toBe("");
  });

  it("leaves commas, double quotes and newlines for AG Grid's CSV quoting", () => {
    const value = 'Acme, "Data"\nTeam';
    expect(csvSafe(value)).toBe(value);
  });
});
