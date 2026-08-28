import { describe, it, expect } from "vitest";
import { decideAuth } from "./auth.js";

const OWNER = 111;
const GROUP = -1002000000000; // forum supergroups have large negative ids

describe("decideAuth", () => {
  describe("when an owner is configured", () => {
    const ctx = { ownerId: OWNER, groupId: GROUP };

    it("allows the owner in their own private chat", () => {
      expect(decideAuth({ userId: OWNER, chatId: OWNER }, ctx)).toBe("allow");
    });

    it("allows the owner in the configured group", () => {
      expect(decideAuth({ userId: OWNER, chatId: GROUP }, ctx)).toBe("allow");
    });

    it("drops a non-owner in their own private chat", () => {
      expect(decideAuth({ userId: 999, chatId: 999 }, ctx)).toBe("drop");
    });

    it("drops a non-owner in the configured group", () => {
      expect(decideAuth({ userId: 999, chatId: GROUP }, ctx)).toBe("drop");
    });

    it("drops the owner in a foreign group", () => {
      expect(decideAuth({ userId: OWNER, chatId: -1009999999999 }, ctx)).toBe("drop");
    });

    it("drops an impersonated private chat (userId != chatId)", () => {
      // A crafted update claiming to be the owner but in someone else's chat.
      expect(decideAuth({ userId: OWNER, chatId: 222 }, ctx)).toBe("drop");
    });
  });

  describe("when no group is configured", () => {
    const ctx = { ownerId: OWNER, groupId: undefined };

    it("still allows the owner's private chat", () => {
      expect(decideAuth({ userId: OWNER, chatId: OWNER }, ctx)).toBe("allow");
    });

    it("drops any group message", () => {
      expect(decideAuth({ userId: OWNER, chatId: GROUP }, ctx)).toBe("drop");
    });
  });

  describe("when no owner is configured (bootstrap)", () => {
    const ctx = { ownerId: 0, groupId: undefined };

    it("lets a private-chat sender bootstrap", () => {
      expect(decideAuth({ userId: 555, chatId: 555 }, ctx)).toBe("bootstrap");
    });

    it("drops a group message before ownership exists", () => {
      expect(decideAuth({ userId: 555, chatId: GROUP }, ctx)).toBe("drop");
    });
  });
});
