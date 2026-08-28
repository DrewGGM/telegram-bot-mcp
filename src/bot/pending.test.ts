import { describe, it, expect } from "vitest";
import { PendingQuestions } from "./pending.js";

describe("PendingQuestions", () => {
  it("resolves the promise with the chosen option", async () => {
    const pq = new PendingQuestions();
    const { id, promise } = pq.register(["Yes", "No"]);
    const res = pq.resolve(pq.callbackData(id, 1));
    expect(res).toEqual({ matched: true, chosen: "No" });
    await expect(promise).resolves.toBe("No");
  });

  it("round-trips callback data", () => {
    const pq = new PendingQuestions();
    const { id } = pq.register(["a", "b", "c"]);
    expect(pq.parse(pq.callbackData(id, 2))).toEqual({ id, index: 2 });
  });

  it("does not match unrelated callback data", () => {
    const pq = new PendingQuestions();
    pq.register(["a"]);
    expect(pq.resolve("noise").matched).toBe(false);
    expect(pq.parse("q:zz:0")).toEqual({ id: "zz", index: 0 });
    expect(pq.resolve("q:zz:0").matched).toBe(false); // unknown id
  });

  it("out-of-range index does not resolve", () => {
    const pq = new PendingQuestions();
    const { id } = pq.register(["only"]);
    expect(pq.resolve(pq.callbackData(id, 5)).matched).toBe(false);
  });

  it("cannot be answered twice", () => {
    const pq = new PendingQuestions();
    const { id } = pq.register(["a", "b"]);
    expect(pq.resolve(pq.callbackData(id, 0)).matched).toBe(true);
    expect(pq.resolve(pq.callbackData(id, 1)).matched).toBe(false);
  });

  it("times out to a sentinel", async () => {
    const pq = new PendingQuestions();
    const { promise } = pq.register(["a"], 5);
    await expect(promise).resolves.toBe("__timeout__");
  });

  it("clear() resolves everything with a sentinel", async () => {
    const pq = new PendingQuestions();
    const { promise } = pq.register(["a"]);
    pq.clear();
    await expect(promise).resolves.toBe("__cancelled__");
  });
});
