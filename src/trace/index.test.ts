import { describe, it, expect } from "vitest";
import { parseTrace, distillTrace, analyzeTrace } from "./index.js";

describe("trace/index barrel exports", () => {
  it("should export parseTrace as a function", () => {
    expect(typeof parseTrace).toBe("function");
  });

  it("should export distillTrace as a function", () => {
    expect(typeof distillTrace).toBe("function");
  });

  it("should export analyzeTrace as a function", () => {
    expect(typeof analyzeTrace).toBe("function");
  });
});
