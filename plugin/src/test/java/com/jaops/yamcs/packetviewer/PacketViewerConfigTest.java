package com.jaops.yamcs.packetviewer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

public class PacketViewerConfigTest {

    static final Map<String, Object> FORMAT = Map.of("name", "CCSDS Packets", "packetInputStreamClassName",
            "org.yamcs.tctm.GenericPacketInputStream", "packetInputStreamArgs", Map.of("lengthFieldOffset", 4));

    @Test
    public void defaults() {
        var c = new PacketViewerConfig(Map.of()).instance("simulator");
        assertEquals("tm_realtime", c.stream());
        assertNull(c.rootContainer());
        assertEquals(1000, c.liveMaxLines());
        assertTrue(c.viewer().isEmpty());
    }

    @Test
    public void instanceOverridesGlobal() {
        var c = new PacketViewerConfig(Map.of(
                "defaultNamespace", "MDB:OPS Name",
                "liveMaxLines", 500,
                "fileFormats", List.of(FORMAT),
                "instances", Map.of("a", Map.of("stream", "tm_dump", "rootContainer", "/a/root", "liveMaxLines", 0,
                        "defaultNamespace", "x"))));
        assertEquals(Set.of("a"), c.configuredInstances());
        var a = c.instance("a");
        assertEquals("tm_dump", a.stream());
        assertEquals("/a/root", a.rootContainer());
        assertEquals(0, a.liveMaxLines());
        assertEquals("x", a.viewer().get("defaultNamespace"));
        assertEquals(List.of(FORMAT), a.viewer().get("fileFormats"));
        // stream, rootContainer and liveMaxLines are not for the viewer
        assertEquals(Set.of("defaultNamespace", "fileFormats"), a.viewer().keySet());
        var b = c.instance("b");
        assertEquals(500, b.liveMaxLines());
        assertEquals("MDB:OPS Name", b.viewer().get("defaultNamespace"));
    }

    @Test
    public void rejectsWhatTheBrowserCannotDo() {
        var e = assertThrows(IllegalArgumentException.class, () -> new PacketViewerConfig(
                Map.of("packetPreprocessorClassName", "org.yamcs.pus.PusPacketPreprocessor")));
        assertTrue(e.getMessage().contains("PusPacketPreprocessor is not supported"), e.getMessage());
        assertThrows(IllegalArgumentException.class, () -> new PacketViewerConfig(Map.of("instances",
                Map.of("a", Map.of("fileFormats", List.of(Map.of("name", "x",
                        "packetInputStreamClassName", "com.example.MyStream")))))));
        assertThrows(IllegalArgumentException.class,
                () -> new PacketViewerConfig(Map.of("fileFormats", List.of(Map.of("name", "x")))));
        assertThrows(IllegalArgumentException.class,
                () -> new PacketViewerConfig(Map.of("fileFormats", List.of(FORMAT, FORMAT))));
        assertThrows(IllegalArgumentException.class, () -> new PacketViewerConfig(Map.of("nope", 1)));
        assertThrows(IllegalArgumentException.class,
                () -> new PacketViewerConfig(Map.of("fileFormats", List.of(Map.of("name", "x",
                        "packetInputStreamClassName", "org.yamcs.tctm.CcsdsPacketInputStream", "extra", 1)))));
    }

    @Test
    public void etag() {
        var a = MdbExports.etag(List.of(new MdbExports.Document("a.xml", "<a/>")));
        assertEquals(34, a.length());
        assertTrue(a.startsWith("\"") && a.endsWith("\""));
        assertEquals(a, MdbExports.etag(List.of(new MdbExports.Document("a.xml", "<a/>"))));
        assertTrue(!a.equals(MdbExports.etag(List.of(new MdbExports.Document("b.xml", "<a/>")))));
    }
}
