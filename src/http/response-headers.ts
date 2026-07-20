import type { FastifyReply } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';

/**
 * Start a response written directly to Node's ServerResponse without dropping
 * headers installed by Fastify hooks (notably @fastify/cors).
 *
 * Passing a headers object to raw.writeHead replaces Fastify-managed headers in
 * light-my-request and can do the same in other raw-response integrations. Merge
 * reply.getHeaders() explicitly so JSON and raw/SSE paths have identical hook
 * behavior.
 */
export function writeRawResponseHead(
  reply: FastifyReply,
  statusCode: number,
  headers: OutgoingHttpHeaders,
): void {
  const mergedHeaders: OutgoingHttpHeaders = {
    ...(reply.getHeaders() as OutgoingHttpHeaders),
    ...headers,
  };
  reply.raw.writeHead(statusCode, mergedHeaders as any);
}
