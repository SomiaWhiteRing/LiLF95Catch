export interface Post {
  thread_id: number;
  post_id: number;
  post_index: number;
  author_id: number;
  author_name: string;
  created_at: string;
  likes_count: number;
  content_html_raw: string;
  content_text_full: string;
  content_length?: number;
  spoilers: {
    title: string;
    html: string;
    text: string;
  }[];
  attachments: {
    type: string;
    remote_url: string;
    filename?: string | null;
    thumb_url?: string | null;
    local_path?: string | null;
  }[];
  capture?: {
    first_seen_at: string;
    last_checked_at: string;
  } | null;
}

export interface ThreadMeta {
  thread_id: number;
  thread_url: string;
  schema_version: number;
  created_at: string;
  last_checked_at: string;
  last_page_known?: number;
  title?: string;
}

export interface PagedPostsResponse {
  thread_id: number;
  page: number;
  pageSize: number;
  total: number;
  items: Post[];
}

export interface UserRecord {
  user_id: number;
  names?: {
    name: string;
    first_seen_post_id: number;
    last_seen_post_id: number;
  }[];
  first_seen_at?: string;
  last_seen_at?: string;
  avatar_url?: string;
  avatar_local_path?: string;
}

export interface UsersFile {
  schema_version: number;
  users: Record<string, UserRecord>;
}
