package com.jaops.yamcs.packetviewer;

import static io.netty.handler.codec.http.HttpHeaderNames.CACHE_CONTROL;
import static io.netty.handler.codec.http.HttpHeaderNames.CONTENT_LENGTH;
import static io.netty.handler.codec.http.HttpHeaderNames.CONTENT_TYPE;
import static io.netty.handler.codec.http.HttpHeaderNames.ETAG;
import static io.netty.handler.codec.http.HttpHeaderNames.IF_NONE_MATCH;
import static io.netty.handler.codec.http.HttpVersion.HTTP_1_1;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;

import org.yamcs.StreamConfig;
import org.yamcs.YamcsServer;
import org.yamcs.http.BadRequestException;
import org.yamcs.http.BodyHandler;
import org.yamcs.http.ForbiddenException;
import org.yamcs.http.HandlerContext;
import org.yamcs.http.HttpException;
import org.yamcs.http.NotFoundException;
import org.yamcs.logging.Log;
import org.yamcs.mdb.Mdb;
import org.yamcs.mdb.MdbFactory;
import org.yamcs.security.SystemPrivilege;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.QueryStringDecoder;

/**
 * {@code GET /packet-viewer/api/{instance}/config} and {@code GET /packet-viewer/api/{instance}/mdb}
 * (docs/plugin.md). Both need the GetMissionDatabase privilege, like the XTCE export of Yamcs; the packets are read
 * with the standard Yamcs APIs and their privileges.
 */
public class PacketViewerHandler extends BodyHandler {
    private static final Log log = new Log(PacketViewerHandler.class);
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    private final PacketViewerConfig config;
    private final MdbExports exports;
    private final ExecutorService pool;

    public PacketViewerHandler(PacketViewerConfig config, MdbExports exports, ExecutorService pool) {
        this.config = config;
        this.exports = exports;
        this.pool = pool;
    }

    @Override
    public boolean requireAuth() {
        return true;
    }

    @Override
    public void handle(HandlerContext ctx) {
        try {
            // the XTCE export of a big MDB takes a while: not on the Netty event loop
            pool.execute(() -> {
                try {
                    route(ctx);
                } catch (Throwable t) {
                    sendError(ctx, t);
                }
            });
        } catch (RejectedExecutionException e) {
            sendError(ctx, new HttpException("the packet viewer is shutting down") {
                private static final long serialVersionUID = 1L;

                @Override
                public HttpResponseStatus getStatus() {
                    return HttpResponseStatus.SERVICE_UNAVAILABLE;
                }
            });
        }
    }

    private void route(HandlerContext ctx) throws HttpException {
        // "", "packet-viewer", "api", instance, resource
        var path = Arrays.stream(ctx.getPathWithoutContext().split("/", -1))
                .map(QueryStringDecoder::decodeComponent).toArray(String[]::new);
        if (path.length != 5 || !path[2].equals("api")) {
            throw new NotFoundException();
        }
        if (!ctx.isGET()) {
            throw new BadRequestException("only GET is supported");
        }
        if (!ctx.getUser().hasSystemPrivilege(SystemPrivilege.GetMissionDatabase)) {
            throw new ForbiddenException("insufficient privileges: GetMissionDatabase is needed");
        }
        var instance = path[3];
        var yi = YamcsServer.getServer().getInstance(instance);
        if (yi == null) {
            throw new NotFoundException("no instance " + instance);
        }
        var mdb = MdbFactory.getInstance(instance);
        if (mdb == null) {
            throw new NotFoundException("instance " + instance + " has no MDB");
        }
        var export = exports.get(instance, mdb, yi.getConfig());
        switch (path[4]) {
        case "config" -> sendJson(ctx, config(instance, mdb, export));
        case "mdb" -> sendMdb(ctx, export);
        default -> throw new NotFoundException("no such packet viewer resource: " + path[4]);
        }
    }

    JsonObject config(String instance, Mdb mdb, MdbExports.Export export) {
        var ic = config.instance(instance);
        var root = ic.rootContainer();
        if (root == null && mdb.getRootSequenceContainer() != null) {
            root = mdb.getRootSequenceContainer().getQualifiedName();
        }
        var o = new JsonObject();
        o.addProperty("instance", instance);
        o.addProperty("stream", ic.stream());
        var tmStreams = new JsonArray();
        for (var e : StreamConfig.getInstance(instance).getTmEntries()) {
            tmStreams.add(e.getName());
        }
        o.add("tmStreams", tmStreams);
        o.addProperty("rootContainer", root);
        o.addProperty("liveMaxLines", ic.liveMaxLines());
        o.addProperty("mdbEtag", export.etag());
        o.add("viewer", GSON.toJsonTree(ic.viewer()));
        return o;
    }

    private static void sendMdb(HandlerContext ctx, MdbExports.Export e) {
        var ifNoneMatch = ctx.getNettyHttpRequest().headers().get(IF_NONE_MATCH);
        DefaultFullHttpResponse response;
        if (e.etag().equals(ifNoneMatch)) {
            response = new DefaultFullHttpResponse(HTTP_1_1, HttpResponseStatus.NOT_MODIFIED);
            response.headers().set(CONTENT_LENGTH, 0);
        } else {
            var json = new JsonObject();
            json.addProperty("source", e.source());
            json.add("documents", GSON.toJsonTree(e.documents()));
            var body = ctx.createByteBuf();
            body.writeBytes(GSON.toJson(json).getBytes(StandardCharsets.UTF_8));
            response = new DefaultFullHttpResponse(HTTP_1_1, HttpResponseStatus.OK, body);
            response.headers().set(CONTENT_TYPE, "application/json");
            response.headers().set(CONTENT_LENGTH, body.readableBytes());
        }
        response.headers().set(ETAG, e.etag());
        // the browser keeps it but asks each time if it changed
        response.headers().set(CACHE_CONTROL, "no-cache");
        ctx.sendResponse(response);
    }

    private static void sendJson(HandlerContext ctx, JsonObject json) {
        send(ctx, HttpResponseStatus.OK, json);
    }

    private static void send(HandlerContext ctx, HttpResponseStatus status, JsonObject json) {
        var body = ctx.createByteBuf();
        body.writeBytes(GSON.toJson(json).getBytes(StandardCharsets.UTF_8));
        var response = new DefaultFullHttpResponse(HTTP_1_1, status, body);
        response.headers().set(CONTENT_TYPE, "application/json");
        response.headers().set(CONTENT_LENGTH, body.readableBytes());
        response.headers().set(CACHE_CONTROL, "no-store");
        ctx.sendResponse(response);
    }

    /** the Yamcs error format: {code, type, msg} */
    private static void sendError(HandlerContext ctx, Throwable t) {
        HttpResponseStatus status;
        if (t instanceof HttpException h) {
            status = h.getStatus();
        } else {
            log.error("Error handling {}", ctx.getNettyHttpRequest().uri(), t);
            status = HttpResponseStatus.INTERNAL_SERVER_ERROR;
        }
        var o = new JsonObject();
        o.addProperty("code", status.code());
        o.addProperty("type", t instanceof HttpException ? t.getClass().getSimpleName() : "InternalServerError");
        o.addProperty("msg", t.getMessage() == null ? t.toString() : t.getMessage());
        send(ctx, status, o);
    }
}
