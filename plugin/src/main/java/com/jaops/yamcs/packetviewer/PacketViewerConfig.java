package com.jaops.yamcs.packetviewer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.yamcs.Spec;
import org.yamcs.Spec.OptionType;

/**
 * The {@code packetViewer:} section of yamcs.yaml (docs/plugin.md). The viewer keys are those of the Java packet
 * viewer's packet-viewer.yaml; each instance may override them.
 *
 * <pre>
 * packetViewer:
 *   defaultNamespace: MDB:OPS Name
 *   liveMaxLines: 1000
 *   packetPreprocessorClassName: org.yamcs.tctm.IssPacketPreprocessor
 *   packetPreprocessorArgs: {}
 *   fileFormats:
 *     - name: CCSDS Packets
 *       packetInputStreamClassName: org.yamcs.tctm.CcsdsPacketInputStream
 *   instances:
 *     simulator:
 *       stream: tm_realtime
 *       rootContainer: /YSS/ccsds-default
 * </pre>
 */
public class PacketViewerConfig {
    /** the splitters and preprocessors implemented in the browser (pv-core) */
    static final Set<String> INPUT_STREAMS = Set.of("org.yamcs.tctm.CcsdsPacketInputStream",
            "org.yamcs.tctm.GenericPacketInputStream");
    static final Set<String> PREPROCESSORS = Set.of("org.yamcs.tctm.IssPacketPreprocessor",
            "org.yamcs.tctm.GenericPacketPreprocessor");

    /** the keys passed to the viewer (pv-core ViewerConfig) */
    static final List<String> VIEWER_KEYS = List.of("defaultNamespace", "packetPreprocessorClassName",
            "packetPreprocessorArgs", "fileFormats", "packetInputStreamClassName", "packetInputStreamArgs");
    static final List<String> FILE_FORMAT_KEYS = List.of("name", "packetInputStreamClassName",
            "packetInputStreamArgs", "packetPreprocessorClassName", "packetPreprocessorArgs", "rootContainer");

    public static final String DEFAULT_STREAM = "tm_realtime";
    public static final int DEFAULT_LIVE_MAX_LINES = 1000;

    private final Map<String, Object> global;
    private final Map<String, Map<String, Object>> instances;

    /** the configuration of an instance */
    public record InstanceConfig(String stream, String rootContainer, int liveMaxLines, Map<String, Object> viewer) {
    }

    static Spec spec() {
        var spec = new Spec();
        addViewerOptions(spec);
        spec.addOption("stream", OptionType.STRING);
        spec.addOption("instances", OptionType.MAP).withSpec(Spec.ANY);
        return spec;
    }

    private static void addViewerOptions(Spec spec) {
        spec.addOption("defaultNamespace", OptionType.STRING);
        spec.addOption("liveMaxLines", OptionType.INTEGER);
        spec.addOption("packetPreprocessorClassName", OptionType.STRING);
        spec.addOption("packetPreprocessorArgs", OptionType.MAP).withSpec(Spec.ANY);
        spec.addOption("packetInputStreamClassName", OptionType.STRING);
        spec.addOption("packetInputStreamArgs", OptionType.MAP).withSpec(Spec.ANY);
        spec.addOption("fileFormats", OptionType.LIST).withElementType(OptionType.MAP).withSpec(Spec.ANY);
    }

    @SuppressWarnings("unchecked")
    public PacketViewerConfig(Map<String, Object> section) {
        this.global = new LinkedHashMap<>(section);
        this.instances = new LinkedHashMap<>();
        var inst = (Map<String, Object>) global.remove("instances");
        if (inst != null) {
            for (var e : inst.entrySet()) {
                if (!(e.getValue() instanceof Map)) {
                    throw new IllegalArgumentException("packetViewer.instances." + e.getKey() + " must be a map");
                }
                instances.put(e.getKey(), (Map<String, Object>) e.getValue());
            }
        }
        check("packetViewer", global);
        for (var e : instances.entrySet()) {
            check("packetViewer.instances." + e.getKey(), e.getValue());
        }
    }

    /** the instances with a configuration of their own */
    public Set<String> configuredInstances() {
        return instances.keySet();
    }

    /** the configuration of an instance: its own keys, else the global ones */
    public InstanceConfig instance(String name) {
        var own = instances.getOrDefault(name, Map.of());
        var merged = new LinkedHashMap<String, Object>(global);
        merged.putAll(own);
        var viewer = new LinkedHashMap<String, Object>();
        for (var k : VIEWER_KEYS) {
            if (merged.get(k) != null) {
                viewer.put(k, merged.get(k));
            }
        }
        var maxLines = merged.get("liveMaxLines");
        return new InstanceConfig((String) merged.getOrDefault("stream", DEFAULT_STREAM),
                (String) merged.get("rootContainer"),
                maxLines == null ? DEFAULT_LIVE_MAX_LINES : ((Number) maxLines).intValue(), viewer);
    }

    /** rejects what the browser cannot do, rather than failing there */
    @SuppressWarnings("unchecked")
    private static void check(String where, Map<String, Object> c) {
        for (var k : c.keySet()) {
            if (!VIEWER_KEYS.contains(k) && !List.of("liveMaxLines", "stream", "rootContainer").contains(k)) {
                throw new IllegalArgumentException(where + ": unknown option " + k);
            }
        }
        checkClass(where, "packetPreprocessorClassName", c.get("packetPreprocessorClassName"), PREPROCESSORS);
        checkClass(where, "packetInputStreamClassName", c.get("packetInputStreamClassName"), INPUT_STREAMS);
        var formats = c.get("fileFormats");
        if (formats == null) {
            return;
        }
        if (!(formats instanceof List)) {
            throw new IllegalArgumentException(where + ".fileFormats must be a list");
        }
        var names = new ArrayList<String>();
        for (var o : (List<Object>) formats) {
            if (!(o instanceof Map)) {
                throw new IllegalArgumentException(where + ".fileFormats: each format must be a map");
            }
            var f = (Map<String, Object>) o;
            var name = f.get("name");
            if (!(name instanceof String) || ((String) name).isEmpty()) {
                throw new IllegalArgumentException(where + ".fileFormats: a format has no name");
            }
            var fw = where + ".fileFormats[" + name + "]";
            if (names.contains(name)) {
                throw new IllegalArgumentException(fw + ": duplicate name");
            }
            names.add((String) name);
            for (var k : f.keySet()) {
                if (!FILE_FORMAT_KEYS.contains(k)) {
                    throw new IllegalArgumentException(fw + ": unknown option " + k);
                }
            }
            if (f.get("packetInputStreamClassName") == null) {
                throw new IllegalArgumentException(fw + ": packetInputStreamClassName is required");
            }
            checkClass(fw, "packetInputStreamClassName", f.get("packetInputStreamClassName"), INPUT_STREAMS);
            checkClass(fw, "packetPreprocessorClassName", f.get("packetPreprocessorClassName"), PREPROCESSORS);
        }
    }

    private static void checkClass(String where, String key, Object value, Set<String> supported) {
        if (value != null && !supported.contains(value)) {
            throw new IllegalArgumentException(where + "." + key + ": " + value
                    + " is not supported by the web packet viewer (supported: " + String.join(", ", supported.stream().sorted().toList()) + ")");
        }
    }
}
