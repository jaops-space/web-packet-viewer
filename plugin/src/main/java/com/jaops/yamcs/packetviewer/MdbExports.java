package com.jaops.yamcs.packetviewer;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.yamcs.YConfiguration;
import org.yamcs.logging.Log;
import org.yamcs.mdb.Mdb;
import org.yamcs.mdb.XtceAssembler;
import org.yamcs.utils.GlobFileFinder;
import org.yamcs.xtce.SpaceSystem;

/**
 * The MDB of an instance as XTCE documents for the browser, computed once per MDB object (an instance restart loads a
 * new one), with an ETag from the content so that the browser downloads it only when it changes.
 * <p>
 * If the MDB is loaded only from XTCE files (loaders of type xtce, without subLoaders), these files are sent: that is
 * exact. Otherwise the MDB is exported with the XTCE assembler of Yamcs, which loses some definitions (in Yamcs 5.14,
 * the dynamic size of a binary encoding becomes -1). Only the telemetry is exported: the viewer needs no commands, and
 * the assembler fails on some command definitions (an AbsoluteTimeArgumentType without ReferenceTime, as in the PUS
 * example); the commands are removed from a copy of the MDB, which stays untouched.
 */
public class MdbExports {
    private static final Log log = new Log(MdbExports.class);

    public record Document(String name, String xtce) {
    }

    /** source: "files" or "export" */
    public record Export(Mdb mdb, String source, List<Document> documents, String etag) {
    }

    private final Map<String, Export> exports = new ConcurrentHashMap<>();

    /** @param instanceConfig the configuration of the instance (yamcs.instance.yaml) */
    public Export get(String instance, Mdb mdb, YConfiguration instanceConfig) {
        return exports.compute(instance, (k, e) -> e != null && e.mdb == mdb ? e : export(instance, mdb, instanceConfig));
    }

    static Export export(String instance, Mdb mdb, YConfiguration instanceConfig) {
        List<Document> docs = null;
        try {
            docs = xtceFiles(loaders(instanceConfig));
        } catch (IOException | RuntimeException e) {
            log.warn("{}: cannot read the XTCE files of the MDB ({}), exporting it instead", instance, e.toString());
        }
        var source = "files";
        if (docs == null) {
            source = "export";
            docs = List.of(new Document(instance + ".xml", new XtceAssembler().toXtce(telemetryOnly(mdb))));
        }
        return new Export(mdb, source, docs, etag(docs));
    }

    /** the MDB loaders of an instance, null if unknown */
    static List<YConfiguration> loaders(YConfiguration instanceConfig) {
        if (instanceConfig == null) {
            return null;
        }
        if (instanceConfig.containsKey("mdbSpec")) {
            return YConfiguration.getConfiguration("mdb").getConfigList(instanceConfig.getString("mdbSpec"));
        }
        if (instanceConfig.isList("mdb")) {
            return instanceConfig.getConfigList("mdb");
        }
        return null;
    }

    /** the XTCE files of the loaders, in order; null if a loader is not a plain XTCE loader */
    static List<Document> xtceFiles(List<YConfiguration> loaders) throws IOException {
        if (loaders == null || loaders.isEmpty()) {
            return null;
        }
        var files = new ArrayList<String>();
        for (var l : loaders) {
            var type = l.getString("type");
            if (!type.equals("xtce") && !type.equals("org.yamcs.mdb.XtceLoader")) {
                return null;
            }
            if (l.containsKey("subLoaders")) {
                return null;
            }
            if (l.containsKey("spec")) {
                files.add(l.getString("spec"));
            } else if (l.containsKey("args")) {
                var args = l.getConfig("args");
                if (args.containsKey("file")) {
                    files.add(args.getString("file"));
                } else if (args.containsKey("fileset")) {
                    List<String> globs = args.get("fileset") instanceof String ? List.of(args.getString("fileset"))
                            : args.getList("fileset");
                    for (var g : globs) {
                        for (var p : new GlobFileFinder().find(g)) {
                            files.add(p.toString());
                        }
                    }
                } else {
                    return null;
                }
            } else {
                return null;
            }
        }
        var docs = new ArrayList<Document>();
        for (var f : files) {
            // relative to the working directory, as for Yamcs
            var p = Path.of(f);
            docs.add(new Document(p.getFileName().toString(), Files.readString(p)));
        }
        return docs;
    }

    /** a copy of the MDB without commands */
    static Mdb telemetryOnly(Mdb mdb) {
        Mdb copy;
        try {
            var out = new ByteArrayOutputStream();
            try (var oos = new ObjectOutputStream(out)) {
                oos.writeObject(mdb);
            }
            try (var ois = new ObjectInputStream(new ByteArrayInputStream(out.toByteArray()))) {
                copy = (Mdb) ois.readObject();
            }
        } catch (IOException | ClassNotFoundException e) {
            throw new IllegalStateException("cannot copy the MDB", e);
        }
        removeCommands(copy.getRootSpaceSystem());
        return copy;
    }

    private static void removeCommands(SpaceSystem ss) {
        ss.getMetaCommands().clear();
        ss.getArgumentTypes().clear();
        ss.getCommandContainers().clear();
        ss.getSubSystems().forEach(MdbExports::removeCommands);
    }

    static String etag(List<Document> docs) {
        try {
            var md = MessageDigest.getInstance("SHA-256");
            for (var d : docs) {
                md.update(d.name().getBytes(StandardCharsets.UTF_8));
                md.update((byte) 0);
                md.update(d.xtce().getBytes(StandardCharsets.UTF_8));
                md.update((byte) 0);
            }
            return "\"" + HexFormat.of().formatHex(md.digest(), 0, 16) + "\"";
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
