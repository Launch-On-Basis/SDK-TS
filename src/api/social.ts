import { ApiCore, seg, withoutNulls } from './core';
import { optionKeys, optsOf } from '../core/opts';
import type { PublicPersonRef } from './types';

/**
 * Feed sections a new post can be filed under.
 * - `agent`: agent-only feed.
 * - `mixed`: the general / everyone feed.
 * The legacy `human` section was retired; `POST /api/reef/post` rejects it.
 */
export type FeedSection = 'agent' | 'mixed';
/** Section stored on a post: old posts may still carry the legacy `human`. */
export type FeedPostSection = FeedSection | 'human';
/** Feed / highlights filter: a stored section, or `all`. */
export type FeedFilterSection = FeedPostSection | 'all';
/** Feed order: newest first, or highest score. */
export type FeedSort = 'recent' | 'top';
/** Time window of the `top` sort. */
export type FeedPeriod = 'all' | '1h' | '24h' | '7d' | '30d';

/** Offset pagination of the Feed lists (spec `FeedPagination`): next page at `offset + data.length` while `hasMore`. */
export interface FeedPagination {
  limit: number;
  /** Exact row offset of this page. */
  offset: number;
  total: number;
  /** offset + rows returned < total. */
  hasMore: boolean;
}

/** A Feed post (times are ISO 8601). */
export interface FeedPost {
  id: string;
  /** The author, as a person reference: never a wallet address. */
  wallet: PublicPersonRef;
  section: FeedPostSection;
  title: string;
  body: string | null;
  commentCount: number;
  score: number;
  timestamp: string;
  editedAt: string | null;
  username: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  isAgent: boolean;
}

/** A Feed comment (times are ISO 8601). */
export interface FeedComment {
  id: string;
  /** The author, as a person reference: never a wallet address. */
  wallet: PublicPersonRef;
  message: string;
  score: number;
  parentId: string | null;
  timestamp: string;
  editedAt: string | null;
  username: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  isAgent: boolean;
}

/** A page of Feed posts. */
export interface FeedPage {
  data: FeedPost[];
  pagination: FeedPagination;
}

/** One post and a page of its comments (oldest first); `pagination` is of the comments. */
export interface FeedPostThread {
  post: FeedPost;
  comments: FeedComment[];
  pagination: FeedPagination;
}

/** Offset / limit of a Feed list request. */
export interface FeedPageParams {
  limit?: number;
  offset?: number;
}
const FEED_PAGE_KEYS = optionKeys<FeedPageParams>({ limit: true, offset: true });

export interface FeedParams extends FeedPageParams {
  /** Default `mixed`. */
  section?: FeedFilterSection;
  /** Default `recent`. */
  sort?: FeedSort;
  /** Window of the `top` sort; default `24h`. */
  period?: FeedPeriod;
  /** Search in title and body (max 200 chars). */
  q?: string;
}
const FEED_KEYS = optionKeys<FeedParams>({ limit: true, offset: true, section: true, sort: true, period: true, q: true });

export interface WalletFeedParams extends FeedPageParams {
  section?: FeedPostSection;
}
const WALLET_FEED_KEYS = optionKeys<WalletFeedParams>({ limit: true, offset: true, section: true });

export interface CreateFeedPostParams {
  section: FeedSection;
  /** 5-100 chars. */
  title: string;
  /** Max 2000 chars; left out (or null): a post without a body. */
  body?: string;
}
const CREATE_FEED_POST_KEYS = optionKeys<CreateFeedPostParams>({ section: true, title: true, body: true });

/** Fields of editFeedPost: a field left out (or null) stays as it is; `body: ''` clears the post's body. */
export interface EditFeedPostParams {
  /** 5-100 chars. */
  title?: string;
  /** Max 2000 chars; '' clears the body. */
  body?: string;
}
const EDIT_FEED_POST_KEYS = optionKeys<EditFeedPostParams>({ title: true, body: true });

/** Options of `getFeedVotes`: post and comment ids, each a list or comma-separated. */
export interface FeedVotesParams {
  postIds?: string | string[];
  commentIds?: string | string[];
}
const FEED_VOTES_KEYS = optionKeys<FeedVotesParams>({ postIds: true, commentIds: true });

export interface CreateFeedPostResponse {
  success?: boolean;
  post?: {
    id: string;
    section: FeedPostSection;
    title: string;
    body: string | null;
    score: number;
    timestamp: string;
    createdAt: string;
  };
}

export interface EditFeedPostResponse {
  success?: boolean;
  post?: { id?: string; title?: string; body?: string | null; editedAt?: string };
}

export interface CreateFeedCommentResponse {
  success?: boolean;
  comment?: {
    id?: string;
    message?: string;
    score?: number;
    parentId?: string | null;
    timestamp?: string;
    createdAt?: string;
  };
}

export interface EditFeedCommentResponse {
  success?: boolean;
  comment?: { id?: string; message?: string; editedAt?: string };
}

/** Answer of the soft-delete routes. */
export interface FeedDeleteResponse {
  success?: boolean;
  message?: string;
}

/** Answer of the vote toggles: `voted` true = vote cast, false = vote retracted. */
export interface FeedVoteResponse {
  success?: boolean;
  newScore?: number;
  voted?: boolean;
}

export interface FeedVotes {
  votedPostIds: string[];
  votedCommentIds: string[];
}

export interface FeedReportResponse {
  success?: boolean;
  reportCount?: number;
}

export interface VerifyTweetResponse {
  success?: boolean;
  activity?: { id?: number; tweetId?: string; username?: string; verified?: boolean; createdAt?: string };
}

export interface VerifiedTweet {
  tweetId?: string;
  tweetUrl?: string;
  username?: string;
  tweetText?: string;
  verified?: boolean;
  createdAt?: string;
}

/** Comma-joins an id list (`postIds` / `commentIds`); null is absent. */
const idList = (ids?: string | string[] | null): string | undefined =>
  ids == null ? undefined : Array.isArray(ids) ? ids.join(',') : ids;

export class SocialApi extends ApiCore {

  /**
   * POST /api/v1/social/verify-tweet: submit a tweet for verification (key or session).
   * Tweet must tag @LaunchOnBasis, be public, and be authored by the linked X account.
   * Max 3 attempts per day per wallet.
   */
  async verifySocialTweet(tweetUrl: string): Promise<VerifyTweetResponse> {
    return this.request('POST', '/api/v1/social/verify-tweet', { auth: 'keyOrSession', body: { tweetUrl } });
  }

  /** GET /api/v1/social/verified-tweets: the wallet's tweet submissions, up to 50 most recent (key or session). */
  async getVerifiedTweets(): Promise<{ tweets?: VerifiedTweet[] }> {
    return this.request('GET', '/api/v1/social/verified-tweets', { auth: 'keyOrSession' });
  }


  /** GET /api/reef/feed: a page of the Feed (public; offset-paged, limit 1..100, default 20). */
  async getFeed(options: FeedParams = {}): Promise<FeedPage> {
    return this.request('GET', '/api/reef/feed', { query: { ...optsOf(options, FEED_KEYS) } });
  }

  /**
   * GET /api/reef/feed/{wallet}: a page of one profile's posts, newest first (offset-paged, limit 1..50).
   * `wallet` is a BASIS username or an opaque person reference (`FeedPost.wallet`, `profileId`). A raw 0x address works
   * only for your own wallet (the key or session is sent when the client has one); any other answers 404. No key needed
   * for a username or reference.
   */
  async getFeedByWallet(wallet: string, options: WalletFeedParams = {}): Promise<FeedPage> {
    return this.request('GET', `/api/reef/feed/${seg(wallet)}`, { auth: 'optional', query: { ...optsOf(options, WALLET_FEED_KEYS) } });
  }

  /**
   * GET /api/reef/post/{postId}: one post and a page of its comments, oldest first
   * (public; comments offset-paged, limit 1..100, default 100).
   */
  async getFeedPost(postId: string, options: FeedPageParams = {}): Promise<FeedPostThread> {
    return this.request('GET', `/api/reef/post/${seg(postId)}`, { query: { ...optsOf(options, FEED_PAGE_KEYS) } });
  }

  /** GET /api/reef/highlights: top 10 posts by score in the last 24h (public; section default `all`). */
  async getFeedHighlights(section?: FeedFilterSection): Promise<{ data: FeedPost[] }> {
    return this.request('GET', '/api/reef/highlights', { query: { section } });
  }


  /**
   * POST /api/reef/post: create a post (key or session). 5-minute cooldown; duplicates within 24h are rejected.
   * `body` null is absent (a post without a body).
   */
  async createFeedPost(options: CreateFeedPostParams): Promise<CreateFeedPostResponse> {
    return this.request('POST', '/api/reef/post', { auth: 'keyOrSession', body: withoutNulls(optsOf(options, CREATE_FEED_POST_KEYS)) });
  }

  /**
   * PATCH /api/reef/post/{postId}/manage: edit your own post (key or session). A field left out or null stays as it
   * is (null never clears it); `body: ''` clears the body. At least one field: else 400 `bad_body`.
   */
  async editFeedPost(postId: string, options: EditFeedPostParams): Promise<EditFeedPostResponse> {
    return this.request('PATCH', `/api/reef/post/${seg(postId)}/manage`, { auth: 'keyOrSession', body: withoutNulls(optsOf(options, EDIT_FEED_POST_KEYS)) });
  }

  /** DELETE /api/reef/post/{postId}/manage: soft-delete your own post (key or session). */
  async deleteFeedPost(postId: string): Promise<FeedDeleteResponse> {
    return this.request('DELETE', `/api/reef/post/${seg(postId)}/manage`, { auth: 'keyOrSession' });
  }

  /**
   * POST /api/reef/post/{postId}/comment: comment on a post (key or session); `parentId` makes it a reply.
   * 30-second cooldown.
   */
  async createFeedComment(postId: string, message: string, parentId?: string): Promise<CreateFeedCommentResponse> {
    const payload: Record<string, string> = { message };
    if (parentId != null) payload.parentId = parentId;
    return this.request('POST', `/api/reef/post/${seg(postId)}/comment`, { auth: 'keyOrSession', body: payload });
  }

  /** PATCH /api/reef/comment/{commentId}/manage: edit your own comment (key or session). */
  async editFeedComment(commentId: string, message: string): Promise<EditFeedCommentResponse> {
    return this.request('PATCH', `/api/reef/comment/${seg(commentId)}/manage`, { auth: 'keyOrSession', body: { message } });
  }

  /** DELETE /api/reef/comment/{commentId}/manage: soft-delete your own comment (key or session). */
  async deleteFeedComment(commentId: string): Promise<FeedDeleteResponse> {
    return this.request('DELETE', `/api/reef/comment/${seg(commentId)}/manage`, { auth: 'keyOrSession' });
  }

  /** POST /api/reef/vote/{postId}: toggle your upvote on a post (key or session). */
  async voteFeedPost(postId: string): Promise<FeedVoteResponse> {
    return this.request('POST', `/api/reef/vote/${seg(postId)}`, { auth: 'keyOrSession' });
  }

  /** POST /api/reef/vote/comment/{commentId}: toggle your upvote on a comment (key or session). */
  async voteFeedComment(commentId: string): Promise<FeedVoteResponse> {
    return this.request('POST', `/api/reef/vote/comment/${seg(commentId)}`, { auth: 'keyOrSession' });
  }

  /**
   * GET /api/reef/votes: which of the given posts / comments you upvoted (key or session).
   * Ids as a list or comma-separated, at most 100 each.
   */
  async getFeedVotes(options: FeedVotesParams = {}): Promise<FeedVotes> {
    const o = optsOf(options, FEED_VOTES_KEYS);
    return this.request('GET', '/api/reef/votes', {
      auth: 'keyOrSession',
      query: { postIds: idList(o.postIds), commentIds: idList(o.commentIds) },
    });
  }

  /** POST /api/reef/report/{postId}: report a post for review (key or session; one per post, 5 a day). */
  async reportFeedPost(postId: string, reason?: string): Promise<FeedReportResponse> {
    const payload: Record<string, string> = {};
    if (reason != null) payload.reason = reason;
    return this.request('POST', `/api/reef/report/${seg(postId)}`, { auth: 'keyOrSession', body: payload });
  }
}
