export type Track = {
  source?: 'local' | 'soundcloud';
  id: string;
  title: string;
  artist: string;
  artwork?: string;
  uri?: string;
  metadata?: string;
  duration?: number;
  permalink?: string;
  streamable?: boolean;
  access?: string;
};
export type Room = {
  id: string;
  name: string;
  model: string;
  host: string;
  coordinator: string;
  group: string;
  volume: number;
  mute: boolean;
  state: string;
  track?: Track;
  position: number;
  duration: number;
  online: boolean;
  lineIn?: boolean;
};
export type Favorite = Track;
export type Diagnostic = {
  at: string;
  source: string;
  code: string;
  message: string;
  hint: string;
};
