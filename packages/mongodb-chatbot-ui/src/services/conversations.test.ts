import { vi } from "vitest";
import {
  ConversationService,
  formatReferences,
  getCustomRequestOrigin,
} from "./conversations";
import { type References } from "mongodb-rag-core";
import * as FetchEventSource from "@microsoft/fetch-event-source";

// Mock fetch for regular awaited HTTP requests
// TODO: make TypeScript compiler ok with this, or skip putting this in the compiled code for staging
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
global.fetch = vi.fn();

function mockFetchResponse<T = unknown>({
  status = 200,
  data,
}: {
  status?: number;
  data: T;
}) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    status,
    json: () => new Promise((resolve) => resolve(data)),
  });
}

// Mock @microsoft/fetch-event-source for SSE streaming requests
vi.mock("@microsoft/fetch-event-source");
declare module "@microsoft/fetch-event-source" {
  export type MockEvent = {
    id?: string;
    type?: string;
    data: string | Record<string, unknown>;
  };
  export function __addMockEvents(...newEvents: MockEvent[]): void;
  export function __clearMockEvents(): void;
}

//Tests
const serverUrl = "https://example.com/api/v1";

describe("ConversationService", () => {
  let conversationService: ConversationService;
  beforeEach(() => {
    conversationService = new ConversationService({
      serverUrl,
    });
  });

  it("throws if serverUrl is not set", () => {
    expect(
      () =>
        new ConversationService({
          serverUrl: undefined as unknown as string,
        })
    ).toThrow("You must define a serverUrl for the ConversationService");
  });

  it("creates conversations", async () => {
    const conversationId = "650b4b260f975ef031016c8a";
    mockFetchResponse({
      data: {
        _id: conversationId,
        messages: [],
      },
    });
    const conversation = await conversationService.createConversation();
    expect(conversation.conversationId).toEqual(conversationId);
    expect(conversation.messages).toEqual([]);
  });

  it("gets an existing conversation", async () => {
    const conversationId = "65c680decdb62b4c92797323";
    mockFetchResponse({
      data: {
        _id: conversationId,
        messages: [
          {
            id: "65c680decdb62b4c92797324",
            role: "user",
            content: "Hello world!",
            createdAt: new Date().toISOString(),
            references: [],
          },
          {
            id: "65c680decdb62b4c92797325",
            role: "assistant",
            content: "I'm sorry, I don't know how to help with that.",
            createdAt: new Date().toISOString(),
            references: [
              { title: "Title 1", url: "https://example.com/1" },
              { title: "Title 2", url: "https://example.com/2" },
              { title: "Title 3", url: "https://example.com/3" },
            ],
          },
        ],
      },
    });
    const conversation = await conversationService.getConversation(conversationId);
    expect(conversation.conversationId).toEqual(conversationId);
    expect(conversation.messages[0].id).toEqual("65c680decdb62b4c92797324");
    expect(conversation.messages[1].id).toEqual("65c680decdb62b4c92797325");
    expect(conversation.messages[2]).toBeUndefined();
  });

  it("throws if you try to get a conversation with an invalid ID", async () => {
    mockFetchResponse({
      status: 400,
      data: { error: "Invalid conversation ID" },
    });
    expect(async () => {
      return conversationService.getConversation("not-a-real-conversation-id");
    }).rejects.toThrow("Invalid conversation ID");
  });

  it("throws if you try to get a non-existent conversation", async () => {
    mockFetchResponse({
      status: 404,
      data: { error: "Conversation not found" },
    });
    expect(async () => {
      // Assumes 65c689e3ccdb70bebc178017 is not in the database
      return conversationService.getConversation("65c689e3ccdb70bebc178017");
    }).rejects.toThrow("Conversation not found");
  });

  it("adds messages w/ an awaited response", async () => {
    const conversationId = "650b4b260f975ef031016c8b";
    const mockMessage = {
      id: "650b4be0d5a57dd66be2ccb8",
      role: "assistant",
      content: "I'm sorry, I don't know how to help with that.",
      createdAt: new Date().toISOString(),
      references: [
        { title: "Title 1", url: "https://example.com/1" },
        { title: "Title 2", url: "https://example.com/2" },
        { title: "Title 3", url: "https://example.com/3" },
      ],
    };
    mockFetchResponse({ data: mockMessage });
    const awaitedMessage = await conversationService.addMessage({
      conversationId,
      message: "Hello world!",
    });
    expect(awaitedMessage).toEqual(mockMessage);
  });

  it("adds messages w/ a streamed response", async () => {
    const conversationId = "650b4b260f975ef031016c8c";
    const mockStreamedMessageId = "651466eecffc98fe887000da";

    FetchEventSource.__addMockEvents(
      {
        id: undefined,
        type: undefined,
        data: { type: "delta", data: "Once upon" },
      },
      {
        id: undefined,
        type: undefined,
        data: { type: "delta", data: " a time there was a" },
      },
      {
        id: undefined,
        type: undefined,
        data: { type: "delta", data: " very long string." },
      },
      {
        id: undefined,
        type: undefined,
        data: {
          type: "references",
          data: [
            { title: "Title 1", url: "https://example.com/1" },
            { title: "Title 2", url: "https://example.com/2" },
            { title: "Title 3", url: "https://example.com/3" },
          ],
        },
      },
      {
        id: undefined,
        type: undefined,
        data: { type: "finished", data: "651466eecffc98fe887000da" },
      }
    );

    let streamedTokens: string[] = [];
    let references: References = [];
    let streamedMessageId: string | undefined;
    let finishedStreaming = false;
    await conversationService.addMessageStreaming({
      conversationId,
      message: "Hello world!",
      maxRetries: 0,
      onResponseDelta: async (data: string) => {
        streamedTokens = [...streamedTokens, data];
      },
      onReferences: async (data: References) => {
        references = data;
      },
      onResponseFinished: async (messageId: string) => {
        streamedMessageId = messageId;
        finishedStreaming = true;
      },
    });
    expect(streamedMessageId).toEqual(mockStreamedMessageId);
    expect(streamedTokens).toEqual([
      "Once upon",
      " a time there was a",
      " very long string.",
    ]);
    expect(references).toEqual([
      { title: "Title 1", url: "https://example.com/1" },
      { title: "Title 2", url: "https://example.com/2" },
      { title: "Title 3", url: "https://example.com/3" },
    ]);
    expect(finishedStreaming).toEqual(true);
  });

  it("rates messages", async () => {
    const conversationId = "650b4b260f975ef031016c8d";
    const ratedMessageId = "650b4be0d5a57dd66be2ccb9";
    const rating = true;
    mockFetchResponse({ status: 204, data: undefined });
    const savedRating = await conversationService.rateMessage({
      conversationId,
      messageId: ratedMessageId,
      rating,
    });
    expect(savedRating).toEqual(rating);
  });

  it("supports user comments on messages", async () => {
    const conversationId = "650b4b260f975ef031016c8d";
    const ratedMessageId = "650b4be0d5a57dd66be2ccb9";
    const comment = "This was a satisfying response.";
    mockFetchResponse({ status: 204, data: undefined });
    const commentPromise = conversationService.commentMessage({
      conversationId,
      messageId: ratedMessageId,
      comment,
    });
    expect(commentPromise).resolves.toBeUndefined();
  });

  it("throws on invalid inputs", async () => {
    const conversationId = "650b4b260f975ef031016c8d";
    const messageId = "650b4be0d5a57dd66be2ccb9";
    const invalidRatingErrorMessage = "Invalid rating";

    mockFetchResponse({
      status: 400,
      data: { error: invalidRatingErrorMessage },
    });

    expect(async () => {
      return conversationService.rateMessage({
        conversationId,
        messageId,
        rating: "true" as unknown as boolean,
      });
    }).rejects.toThrow(invalidRatingErrorMessage);

    const invalidCommentErrorMessage = "Failed to save comment on message";
    mockFetchResponse({
      status: 400,
      data: { error: invalidCommentErrorMessage },
    });

    expect(async () => {
      return conversationService.commentMessage({
        conversationId,
        messageId,
        comment: 42 as unknown as string,
      });
    }).rejects.toThrow(invalidCommentErrorMessage);

    const invalidConversationIdErrorMessage = "Invalid conversation ID";
    mockFetchResponse({
      status: 400,
      data: { error: invalidConversationIdErrorMessage },
    });
    expect(async () => {
      return conversationService.rateMessage({
        conversationId: "abcdefg this is not ObjectId",
        messageId,
        rating: true,
      });
    }).rejects.toThrow(invalidConversationIdErrorMessage);
  });

  it("throws on server errors", async () => {
    const conversationId = "650b4b260f975ef031016c8d";
    const messageId = "650b4be0d5a57dd66be2ccb9";
    const internalServerErrorMessage = "Internal server error";

    mockFetchResponse({
      status: 500,
      data: { error: internalServerErrorMessage },
    });

    expect(async () => {
      return conversationService.addMessage({
        conversationId,
        message: "Hello world!",
      });
    }).rejects.toThrow(internalServerErrorMessage);

    expect(async () => {
      return conversationService.rateMessage({
        conversationId,
        messageId,
        rating: true,
      });
    }).rejects.toThrow(internalServerErrorMessage);
  });
});

describe("formatReferences", () => {
  it("returns an empty string if references is empty", () => {
    expect(formatReferences([])).toEqual("");
  });

  it("formats a list of reference links into a markdown list", () => {
    const references = [
      {
        title: "Title 1",
        url: "https://example.com/1",
      },
      {
        title: "Title 2",
        url: "https://example.com/2",
      },
    ];
    expect(formatReferences(references)).toEqual(
      "\n\n**Related resources:**\n\n" +
        "- [Title 1](https://example.com/1)\n\n" +
        "- [Title 2](https://example.com/2)"
    );
  });
});

describe("getCustomRequestOrigin", () => {
  it("returns the current window location if it exists", () => {
    const mockWindowLocation = "https://example.com/foo/bar";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).window = {
      ...global.window,
      location: {
        ...global.window.location,
        href: mockWindowLocation,
      },
    };
    expect(getCustomRequestOrigin()).toEqual(mockWindowLocation);
  });

  it("returns null if the current window location does not exist", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).window = undefined;
    expect(getCustomRequestOrigin()).toEqual(undefined);
  });
});
