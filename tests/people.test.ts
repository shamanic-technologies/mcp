import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  headApi: vi.fn(async () => ({ status: 200, etag: null })),
  setApiKey: vi.fn(),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
}));

import { handleToolCall, toolDefinitions } from "../src/tools/index.js";
import { callApi } from "../src/lib/api-client.js";

const mockCallApi = vi.mocked(callApi);
const BRAND = "bbbbbbbb-1111-4111-8111-000000000001";
const MOM = "bbbbbbbb-1111-4111-8111-000000000002";
const FIX = "bbbbbbbb-1111-4111-8111-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
});

/** A person exactly as crm-service serves it on GET /orgs/people (gateway passthrough). */
const mom = {
  personId: MOM,
  personKey: "phone:+33612345678",
  identityKeys: ["phone:+33612345678"],
  displayName: "Mom",
  company: null,
  emails: [],
  phones: ["+33612345678"],
  sources: ["matrix"],
  lastActivityAt: "2026-10-16T10:00:00.000Z",
  state: "in_conversation",
  presences: [{ source: "matrix" }],
  mergeEvidence: [],
  connectionTags: [
    { tag: "personal_to_user", userIds: ["u1"], brandId: null, basis: [{ kind: "conversation", ref: "matrix:1", probability: 0.9 }] },
  ],
  organizations: [
    {
      companyId: "bbbbbbbb-1111-4111-8111-00000000000c",
      domain: "acme.com",
      evidence: [{ kind: "user", value: "acme.com", source: "correction" }],
      tags: [{ tag: "professional_to_brand", userIds: [], brandId: BRAND, basis: [{ kind: "user_correction", ref: FIX, probability: null }] }],
    },
  ],
};

describe("distribute_find_people", () => {
  it("searches the brand's people and serves their tags and companies in words", async () => {
    mockCallApi.mockResolvedValue({ data: { brandId: BRAND, scope: { status: "ready" }, total: 1, nextOffset: null, people: [mom] } });

    const result = (await handleToolCall("distribute_find_people", { brandId: BRAND, q: "Mom" })) as Record<string, any>;

    expect(mockCallApi).toHaveBeenCalledWith(`/v1/orgs/people?brandId=${BRAND}&limit=20&q=Mom`);
    const p = result.people[0];
    expect(p.personId).toBe(MOM);
    expect(p.name).toBe("Mom");
    expect(p.tags).toEqual([
      { tag: "personal_to_user", meaning: expect.stringContaining("family"), statedByUser: false },
    ]);
    expect(p.companies).toEqual([
      { companyId: "bbbbbbbb-1111-4111-8111-00000000000c", domain: "acme.com", statedByUser: true, tags: ["professional_to_brand"] },
    ]);
    // Internal identity keys never reach the assistant.
    expect(JSON.stringify(result)).not.toContain("phone:+33612345678");
  });

  it("says who stated a tag: the user's own fix carries its correction id", async () => {
    const corrected = { ...mom, connectionTags: [{ tag: "professional_to_brand", userIds: [], brandId: BRAND, basis: [{ kind: "user_correction", ref: FIX, probability: null }] }] };
    mockCallApi.mockResolvedValue({ data: { people: [corrected] } });
    const result = (await handleToolCall("distribute_find_people", { brandId: BRAND })) as Record<string, any>;
    expect(result.people[0].tags[0]).toMatchObject({ tag: "professional_to_brand", statedByUser: true, correctionIds: [FIX] });
  });
});

describe("distribute_correct_person", () => {
  it("states \"Mom is a client, not family\" as the API's kinds, brand in query and body", async () => {
    mockCallApi.mockResolvedValue({
      status: 201,
      data: {
        correction: { correctionId: FIX, kind: "tag_remove", personId: MOM, target: { tag: "personal_to_user" }, reason: null, statedByUserId: "u1", createdAt: "2026-10-17T12:00:00.000Z", undoneAt: null, undoneByUserId: null },
        duplicate: false,
        rebuild: "started",
      },
    });

    const result = (await handleToolCall("distribute_correct_person", {
      brandId: BRAND,
      change: "remove_tag",
      personId: MOM,
      tag: "personal_to_user",
      reason: "Mom is a client, not family",
    })) as Record<string, any>;

    expect(mockCallApi).toHaveBeenCalledWith(`/v1/orgs/people/corrections?brandId=${BRAND}`, {
      method: "POST",
      body: { brandId: BRAND, kind: "tag_remove", personId: MOM, tag: "personal_to_user", reason: "Mom is a client, not family" },
    });
    expect(result.correction).toMatchObject({ correctionId: FIX, change: "remove_tag", personId: MOM });
    expect(result.correction).not.toHaveProperty("statedByUserId");
    expect(result.next).toContain("distribute_undo_people_correction");
  });

  it("maps every change word onto the API's kind", async () => {
    mockCallApi.mockResolvedValue({ status: 201, data: { correction: { correctionId: FIX }, duplicate: false } });
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["add_tag", { personId: MOM, tag: "professional_to_brand" }, "tag_add"],
      ["add_company", { personId: MOM, domain: "acme.com" }, "organization_add"],
      ["remove_company", { personId: MOM, companyId: FIX }, "organization_remove"],
      ["domain_is", { domain: "mybiz.co", domainKind: "organization" }, "domain_kind"],
    ];
    for (const [change, extra, kind] of cases) {
      await handleToolCall("distribute_correct_person", { brandId: BRAND, change, ...extra });
      const body = (mockCallApi.mock.calls.at(-1)![1] as { body: Record<string, unknown> }).body;
      expect(body).toEqual({ brandId: BRAND, kind, ...extra });
    }
  });

  it("hands back a refusal with its reason and what to do next", async () => {
    mockCallApi.mockResolvedValue({
      error: "no person x in this brand",
      errorBody: { type: "refused", reason: "person_not_found", error: "no person x in this brand" },
      status: 404,
    });
    const err = await handleToolCall("distribute_correct_person", { brandId: BRAND, change: "add_tag", personId: MOM, tag: "professional_to_brand" }).catch((e) => e);
    const body = JSON.parse((err as Error).message);
    expect(body).toMatchObject({ status: 404, reason: "person_not_found", error: "no person x in this brand" });
    expect(body.fix).toContain("distribute_find_people");
  });

  it("refuses an unknown change before any call", async () => {
    await expect(handleToolCall("distribute_correct_person", { brandId: BRAND, change: "delete_person" })).rejects.toThrow(/Unknown change/);
    expect(mockCallApi).not.toHaveBeenCalled();
  });
});

describe("listing and undoing fixes", () => {
  it("lists corrections and merges together, changes in the tool's words", async () => {
    mockCallApi.mockImplementation(async (path: string) =>
      path.startsWith("/v1/orgs/people/corrections")
        ? { data: { brandId: BRAND, corrections: [{ correctionId: FIX, kind: "tag_add", personId: MOM, target: { tag: "professional_to_brand" } }] } }
        : { data: { brandId: BRAND, merges: [{ mergeId: "m1" }] } },
    );
    const result = (await handleToolCall("distribute_list_people_corrections", { brandId: BRAND })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith(`/v1/orgs/people/corrections?brandId=${BRAND}`);
    expect(mockCallApi).toHaveBeenCalledWith(`/v1/orgs/people/merges?brandId=${BRAND}`);
    expect(result.corrections[0]).toMatchObject({ correctionId: FIX, change: "add_tag" });
    expect(result.merges).toEqual([{ mergeId: "m1" }]);
  });

  it("undoes a correction by id", async () => {
    mockCallApi.mockResolvedValue({ data: { correction: { correctionId: FIX, kind: "tag_add", undoneAt: "2026-10-17T12:05:00.000Z" }, duplicate: false } });
    const result = (await handleToolCall("distribute_undo_people_correction", { brandId: BRAND, correctionId: FIX })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith(`/v1/orgs/people/corrections/${FIX}/undo?brandId=${BRAND}`, { method: "POST", body: { brandId: BRAND } });
    expect(result.correction.change).toBe("add_tag");
  });

  it("merges two people and undoes the merge", async () => {
    mockCallApi.mockResolvedValue({ status: 201, data: { merge: { mergeId: "m1" }, duplicate: false } });
    await handleToolCall("distribute_merge_people", { brandId: BRAND, personIds: [MOM, FIX] });
    expect(mockCallApi).toHaveBeenCalledWith(`/v1/orgs/people/merges?brandId=${BRAND}`, { method: "POST", body: { brandId: BRAND, personIds: [MOM, FIX] } });

    mockCallApi.mockResolvedValue({ data: { merge: { mergeId: "m1" }, duplicate: false } });
    await handleToolCall("distribute_undo_people_merge", { brandId: BRAND, mergeId: "m1" });
    expect(mockCallApi).toHaveBeenCalledWith(`/v1/orgs/people/merges/m1/undo?brandId=${BRAND}`, { method: "POST", body: { brandId: BRAND } });
  });

  it("reads the companies of the brand's people", async () => {
    mockCallApi.mockResolvedValue({ data: { brandId: BRAND, total: 1, organizations: [{ companyId: FIX, domains: ["acme.com"], people: 2, tags: [] }] } });
    const result = (await handleToolCall("distribute_list_people_companies", { brandId: BRAND })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith(`/v1/orgs/people/organizations?brandId=${BRAND}`);
    expect(result.companies[0].domains).toEqual(["acme.com"]);
  });
});

describe("every people tool says when to use it, in the user's words", () => {
  const tools = [
    "distribute_find_people",
    "distribute_list_people_companies",
    "distribute_correct_person",
    "distribute_list_people_corrections",
    "distribute_undo_people_correction",
    "distribute_merge_people",
    "distribute_undo_people_merge",
  ] as const;
  it("names its trigger phrases", () => {
    const d = toolDefinitions as Record<string, { description: string }>;
    expect(d.distribute_correct_person.description).toContain("Mom is a client of mine, not family");
    expect(d.distribute_correct_person.description).toContain("she left Acme");
    expect(d.distribute_correct_person.description).toContain("mybiz.co is a company, not a public mailbox");
    expect(d.distribute_merge_people.description).toContain("these two are the same person");
    expect(d.distribute_undo_people_correction.description).toContain("undo that");
    for (const t of tools) expect(d[t]).toBeDefined();
  });
});
