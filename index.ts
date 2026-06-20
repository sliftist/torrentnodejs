// Public exports.
export { BitTorrentClient } from "./client";
export type { BitTorrentClientOptions } from "./client";
export { Torrent } from "./torrent";
export type { TorrentOptions } from "./torrent";
export type { TorrentMeta, TorrentFile } from "./torrentFile";
export { parseTorrentFile, parseTorrentBuffer, pieceLengthAt } from "./torrentFile";

// Selection + types around the piece layer
export { PieceManager, BLOCK_SIZE } from "./pieceManager";
export type { PieceSelection, BlockRequest } from "./pieceManager";

// Transport — implement this interface to swap in WireGuardNetwork (or anything else).
export { NodeTransport } from "./transport";
export type { Transport, FetchInit, FetchResponse, UdpSocketLike, UdpRemoteInfo, ConnectTcpOptions } from "./transport";

// Lower-level building blocks
export { Bitfield } from "./bitfield";
export { PeerConnection } from "./peerConnection";
export { Storage } from "./storage";
export { TrackerPool } from "./trackerPool";
export { announceHttp } from "./trackerHttp";
export { announceUdp } from "./trackerUdp";
export type { PeerAddress, AnnounceParams, TrackerAnnounceResult } from "./trackerHttp";

// Torrent file creation
export { createTorrentFromFile, createTorrentFromData, magnetUri } from "./createTorrent";
export type { CreateTorrentOptions } from "./createTorrent";

// Bencode (for advanced use cases)
export { decode as bdecode, encode as bencode } from "./bencode";
export type { BencodeValue, BencodeDict } from "./bencode";
