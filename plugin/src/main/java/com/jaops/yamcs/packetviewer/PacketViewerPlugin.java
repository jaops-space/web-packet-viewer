package com.jaops.yamcs.packetviewer;

import java.io.IOException;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipInputStream;

import org.yamcs.Plugin;
import org.yamcs.PluginException;
import org.yamcs.Spec;
import org.yamcs.YConfiguration;
import org.yamcs.YamcsServer;
import org.yamcs.http.HttpServer;
import org.yamcs.logging.Log;

/**
 * The packet viewer plugin ({@code web-packet-viewer}): the Packet Viewer page of Yamcs-web, which decodes the
 * packets in the browser, and the HTTP resources it needs under {@code /packet-viewer/api/{instance}/} (docs/plugin.md).
 * <p>
 * Its configuration is the {@code packetViewer:} section of yamcs.yaml. Yamcs would name the section after the plugin,
 * which must stay {@code web-packet-viewer} for Yamcs-web to create the {@code <web-packet-viewer>} element.
 */
public class PacketViewerPlugin implements Plugin {
    private static final Log log = new Log(PacketViewerPlugin.class);
    public static final String CONFIG_SECTION = "packetViewer";
    public static final String NAME = "web-packet-viewer";
    /** the directory of the web UI in the jar */
    static final String WEB = "packet-viewer-web";

    @Override
    public Spec getSpec() {
        YamcsServer.getServer().addConfigurationSection(CONFIG_SECTION, PacketViewerConfig.spec());
        return new Spec();
    }

    @Override
    public void onLoad(YConfiguration pluginConfig) throws PluginException {
        var yamcs = YamcsServer.getServer();
        var httpServer = yamcs.getGlobalService(HttpServer.class);
        if (httpServer == null) {
            throw new PluginException("the packet viewer plugin needs the HttpServer service");
        }
        PacketViewerConfig config;
        try {
            config = new PacketViewerConfig(yamcs.getConfig().getConfigOrEmpty(CONFIG_SECTION).getRoot());
        } catch (IllegalArgumentException e) {
            throw new PluginException(e.getMessage());
        }
        var n = new AtomicInteger();
        var pool = Executors.newCachedThreadPool(r -> {
            var t = new Thread(r, "packet-viewer-http-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
        var handler = new PacketViewerHandler(config, new MdbExports(), pool);
        httpServer.addRoute("packet-viewer", () -> handler);
        var meta = yamcs.getPluginManager().getMetadata(getClass());
        log.info("packet viewer {}: configured instances {}", meta == null ? "unknown" : meta.getVersion(),
                config.configuredInstances());
        deployWebExtension(yamcs.getDataDirectory().resolve("packet-viewer").resolve("web"));
    }

    /**
     * Extracts the UI (packet-viewer-web/ in the jar) and adds it to Yamcs-web; nothing if the jar has none. As for
     * fops, the directory must not change afterwards (the Yamcs-web 5.14 redeployer fails otherwise).
     */
    private void deployWebExtension(Path dir) throws PluginException {
        try {
            if (Files.exists(dir)) {
                try (var walk = Files.walk(dir)) {
                    walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
                }
            }
            Files.createDirectories(dir);
            var n = extract(dir);
            if (n == 0) {
                log.info("packet viewer: no web UI in the plugin (built without ../web/dist)");
                return;
            }
            if (addWebExtension(dir)) {
                log.info("packet viewer: web UI ({} files) deployed from {}", n, dir);
            }
        } catch (IOException | URISyntaxException e) {
            throw new PluginException("cannot deploy the packet viewer web UI", e);
        }
    }

    private static boolean addWebExtension(Path dir) {
        Class<?> webPluginClass;
        try {
            webPluginClass = Class.forName("org.yamcs.web.WebPlugin");
        } catch (ClassNotFoundException e) {
            log.info("packet viewer: no Yamcs-web, the web UI is not deployed");
            return false;
        }
        return addExtension(webPluginClass, dir);
    }

    @SuppressWarnings("unchecked")
    private static boolean addExtension(Class<?> webPluginClass, Path dir) {
        var plugin = YamcsServer.getServer().getPluginManager()
                .getPlugin((Class<? extends Plugin>) webPluginClass);
        if (plugin == null) {
            log.info("packet viewer: Yamcs-web is disabled, the web UI is not deployed");
            return false;
        }
        ((org.yamcs.web.WebPlugin) plugin).addExtension(NAME, Map.of(), dir);
        return true;
    }

    /** Copies packet-viewer-web/ of the plugin's jar (or classes directory) to dir; the number of files. */
    private int extract(Path dir) throws IOException, URISyntaxException {
        var source = Path.of(getClass().getProtectionDomain().getCodeSource().getLocation().toURI());
        int n = 0;
        if (Files.isDirectory(source)) {
            var web = source.resolve(WEB);
            if (!Files.isDirectory(web)) {
                return 0;
            }
            try (var walk = Files.walk(web)) {
                for (var p : (Iterable<Path>) walk::iterator) {
                    var target = dir.resolve(web.relativize(p).toString());
                    if (Files.isDirectory(p)) {
                        Files.createDirectories(target);
                    } else {
                        Files.copy(p, target, StandardCopyOption.REPLACE_EXISTING);
                        n++;
                    }
                }
            }
            return n;
        }
        var prefix = WEB + "/";
        try (InputStream in = Files.newInputStream(source); var zip = new ZipInputStream(in)) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                var name = entry.getName();
                if (!name.startsWith(prefix) || name.equals(prefix)) {
                    continue;
                }
                var target = dir.resolve(name.substring(prefix.length())).normalize();
                if (!target.startsWith(dir)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    Files.createDirectories(target);
                } else {
                    Files.createDirectories(target.getParent());
                    Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
                    n++;
                }
            }
        }
        return n;
    }
}
