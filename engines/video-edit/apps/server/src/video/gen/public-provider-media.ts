import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pinnedSourceRequestOptions, resolvePublicSourceTarget, type SourceResolver } from "../marketing-source-fetcher.js";

/** Read a supplier's media URL without following redirects or resolving the target a second time. */
export async function fetchPublicProviderMedia(rawUrl: string, signal: AbortSignal, resolver?: SourceResolver): Promise<Response> {
  const { url, address } = await resolvePublicSourceTarget(rawUrl, signal, resolver);
  return new Promise((resolve, reject) => {
    const options = pinnedSourceRequestOptions(address, signal, {
      "user-agent": "WorkLoom-VideoMedia/1.0",
      accept: "video/*,image/*,application/octet-stream",
    });
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, response => {
      response.once("error", reject);
      try {
        const status = response.statusCode ?? 502;
        if (status < 200 || status > 599) throw new Error("MEDIA_RESPONSE_INVALID：无有效的 HTTP 响应状态");
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
        }
        const encoding = headers.get("content-encoding");
        if (status >= 200 && status < 300 && encoding && encoding.toLowerCase() !== "identity") {
          throw new Error("MEDIA_ENCODING_UNSUPPORTED：供应商媒体未按原始字节返回");
        }
        // A non-success status, including redirects, is returned without opening another connection.
        if (status < 200 || status >= 300 || status === 204 || status === 205) {
          response.destroy();
          resolve(new Response(null, { status, headers }));
        } else {
          const stream = Readable.toWeb(response) as ReadableStream<Uint8Array>;
          resolve(new Response(stream, { status, headers }));
        }
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
}
