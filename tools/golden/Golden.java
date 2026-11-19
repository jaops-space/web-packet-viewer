import java.io.BufferedInputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Hashtable;
import java.util.List;
import java.util.Map;

import javax.swing.tree.DefaultMutableTreeNode;

import org.yamcs.YConfiguration;
import org.yamcs.mdb.ContainerProcessingResult;
import org.yamcs.mdb.Mdb;
import org.yamcs.mdb.MdbFactory;
import org.yamcs.mdb.XtceAssembler;
import org.yamcs.mdb.XtceTmExtractor;
import org.yamcs.parameter.ContainerParameterValue;
import org.yamcs.parameter.ParameterValue;
import org.yamcs.parameter.ParameterValueList;
import org.yamcs.tctm.PacketInputStream;
import org.yamcs.ui.packetviewer.ListPacket;
import org.yamcs.ui.packetviewer.filter.FilterParser;
import org.yamcs.ui.packetviewer.filter.PacketFilter;
import org.yamcs.utils.TimeEncoding;
import org.yamcs.utils.YObjectLoader;
import org.yamcs.xtce.BaseDataType;
import org.yamcs.xtce.Calibrator;
import org.yamcs.xtce.DataEncoding;
import org.yamcs.xtce.EnumeratedParameterType;
import org.yamcs.xtce.FloatDataEncoding;
import org.yamcs.xtce.IntegerDataEncoding;
import org.yamcs.xtce.NameDescription;
import org.yamcs.xtce.Parameter;
import org.yamcs.xtce.ParameterType;
import org.yamcs.xtce.SequenceContainer;
import org.yamcs.xtce.SpaceSystem;

/**
 * Prints what the Java packet viewer computes for a packet file (packet names, parameter tables, structure trees)
 * and for a list of filters (validity, matching packets), for comparison with pv-core.
 *
 * Usage (etc/ in the classpath, from the directory of the MDB files):
 * java -cp "etc:lib/*" Golden.java mdbConfig packetFile filtersFile [xtceExportFile]
 * <p>
 * With xtceExportFile, also writes the XTCE of the MDB as the plugin exports it (MdbExports: without commands).
 */
public class Golden {
    static Mdb mdb;
    static SequenceContainer root;

    public static void main(String[] args) throws Exception {
        YConfiguration.setupTool();
        TimeEncoding.setUp();
        mdb = MdbFactory.createInstanceByConfig(args[0]);
        root = mdb.getRootSequenceContainer();
        if (args.length > 3) {
            Files.writeString(Path.of(args[3]), new XtceAssembler().toXtce(telemetryOnly(mdb)));
        }
        YConfiguration pvconf = YConfiguration.getConfiguration("packet-viewer");
        YConfiguration ff = pvconf.getConfigList("fileFormats").get(0);
        Map<String, Object> isArgs = ff.containsKey("packetInputStreamArgs") ? ff.getMap("packetInputStreamArgs")
                : Map.of();

        List<byte[]> packets = new ArrayList<>();
        try (InputStream in = new BufferedInputStream(new FileInputStream(args[1]))) {
            PacketInputStream pis = YObjectLoader.loadObject(ff.getString("packetInputStreamClassName"));
            pis.init(in, YConfiguration.wrap(isArgs));
            byte[] p;
            try {
                while ((p = pis.readPacket()) != null) {
                    packets.add(p);
                }
            } catch (java.io.EOFException e) {
                // end
            }
        }
        StringBuilder out = new StringBuilder();
        out.append("root " + root.getQualifiedName() + "\n");

        // the list pass, without columns: packet names
        List<ListPacket> list = listPass(packets, List.of());
        // the detail pass of each packet
        XtceTmExtractor all = new XtceTmExtractor(mdb);
        all.provideAll();
        for (int i = 0; i < packets.size(); i++) {
            byte[] p = packets.get(i);
            out.append("#" + (i + 1) + " " + list.get(i).getName() + " " + p.length + "\n");
            ContainerProcessingResult cpr = all.processPacket(p, 0, 0, 0, root);
            details(cpr.getParameterResult(), list.get(i).getName(), out);
        }

        // the filters; the filter parameters are subscribed before loading the packets
        for (String f : Files.readAllLines(Path.of(args[2]))) {
            if (f.isBlank()) {
                continue;
            }
            out.append("F " + f + "\n");
            try {
                new FilterParser(new StringReader(f)).compileExpression();
            } catch (Throwable e) {
                out.append("invalid\n");
                continue;
            }
            PacketFilter pf = new PacketFilter(f, mdb);
            List<ListPacket> l = listPass(packets, new ArrayList<>(pf.getParameters()));
            StringBuilder nrs = new StringBuilder();
            int n = 0;
            int errors = 0;
            for (int i = 0; i < l.size(); i++) {
                boolean m;
                try {
                    m = pf.matches(l.get(i));
                } catch (RuntimeException e) {
                    // Java bugs: NullPointerException for a qualified name not in the packet,
                    // NumberFormatException for a numeric comparison with a non-number; pv-core: no match
                    m = false;
                    errors++;
                }
                if (m) {
                    n++;
                    nrs.append(nrs.length() == 0 ? "" : ",").append(i + 1);
                }
            }
            out.append("match " + n + " " + nrs + "\n");
            if (errors > 0) {
                System.err.println(f + ": " + errors + " Java exceptions");
            }
        }
        System.out.print(out);
    }

    /** as plugin/.../MdbExports.telemetryOnly */
    static Mdb telemetryOnly(Mdb mdb) throws Exception {
        var out = new java.io.ByteArrayOutputStream();
        try (var oos = new java.io.ObjectOutputStream(out)) {
            oos.writeObject(mdb);
        }
        Mdb copy;
        try (var ois = new java.io.ObjectInputStream(new java.io.ByteArrayInputStream(out.toByteArray()))) {
            copy = (Mdb) ois.readObject();
        }
        removeCommands(copy.getRootSpaceSystem());
        return copy;
    }

    static void removeCommands(SpaceSystem ss) {
        ss.getMetaCommands().clear();
        ss.getArgumentTypes().clear();
        ss.getCommandContainers().clear();
        ss.getSubSystems().forEach(Golden::removeCommands);
    }

    /** PacketsTable.setupParameterColumns + packetReceived */
    static List<ListPacket> listPass(List<byte[]> packets, List<Parameter> params) {
        XtceTmExtractor tmExtractor = new XtceTmExtractor(mdb);
        for (Parameter p : params) {
            tmExtractor.startProviding(p);
        }
        if (mdb.getInheritingContainers(root) == null) {
            tmExtractor.startProviding(root);
        } else {
            for (SequenceContainer sc : mdb.getInheritingContainers(root)) {
                tmExtractor.startProviding(sc);
            }
        }
        List<ListPacket> l = new ArrayList<>();
        for (byte[] buf : packets) {
            ListPacket packet = new ListPacket(buf, buf.length);
            ContainerProcessingResult cpr = tmExtractor.processPacket(buf, 0, 0, 0, root);
            packet.setColumnParameters(cpr.getParameterResult());
            SequenceContainer sc = null;
            for (var cer : cpr.getContainerResult()) {
                if (cer.getOffset() > 0) {
                    continue;
                }
                sc = cer.getContainer();
            }
            packet.setName(sc == null ? "unknown" : sc.getQualifiedName());
            l.add(packet);
        }
        return l;
    }

    /** PacketViewer.process and ParametersTableModel.getValueAt */
    static void details(ParameterValueList params, String name, StringBuilder out) {
        DefaultMutableTreeNode structureRoot = new DefaultMutableTreeNode(name);
        Hashtable<String, DefaultMutableTreeNode> containers = new Hashtable<>();
        for (ParameterValue pv : params) {
            if (pv instanceof ContainerParameterValue cpv) {
                getTreeNode(structureRoot, containers, cpv.getContainerStartOffset(),
                        cpv.getSequenceEntry().getSequenceContainer())
                        .add(new DefaultMutableTreeNode(String.format("%d/%d %s", cpv.getAbsoluteBitOffset(),
                                cpv.getBitSize(), opsName(pv.getParameter()))));
            }
            List<String> row = new ArrayList<>();
            row.add(pv.getParameter().getName());
            row.add(pv.getEngValue() != null ? pv.getEngValue().toString() : "-");
            row.add(pv.getRawValue() != null ? pv.getRawValue().toString() : "-");
            row.add(pv instanceof ContainerParameterValue c ? String.valueOf(c.getAbsoluteBitOffset()) : "-");
            row.add(pv instanceof ContainerParameterValue c ? String.valueOf(c.getBitSize()) : "-");
            row.add(calibration(pv.getParameter()));
            out.append("  " + String.join("\t", row) + "\n");
        }
        tree(structureRoot, 0, out);
    }

    static String calibration(Parameter p) {
        ParameterType paramtype = p.getParameterType();
        if (paramtype instanceof EnumeratedParameterType) {
            return "LOV " + ((EnumeratedParameterType) paramtype).getName();
        } else if (paramtype instanceof BaseDataType) {
            DataEncoding encoding = ((BaseDataType) paramtype).getEncoding();
            Calibrator calib = null;
            if (encoding instanceof IntegerDataEncoding) {
                calib = ((IntegerDataEncoding) encoding).getDefaultCalibrator();
            } else if (encoding instanceof FloatDataEncoding) {
                calib = ((FloatDataEncoding) encoding).getDefaultCalibrator();
            }
            return calib == null ? "" : calib.toString();
        } else {
            return "-";
        }
    }

    static DefaultMutableTreeNode getTreeNode(DefaultMutableTreeNode structureRoot,
            Hashtable<String, DefaultMutableTreeNode> containers, int startOffset, SequenceContainer sc) {
        String sckey = startOffset + ":" + opsName(sc);
        if (sc.getBaseContainer() == null) {
            if (startOffset == 0) {
                return structureRoot;
            } else {
                return containers.computeIfAbsent(sckey, k -> {
                    DefaultMutableTreeNode tc1 = new DefaultMutableTreeNode(opsName(sc));
                    structureRoot.add(tc1);
                    return tc1;
                });
            }
        }
        DefaultMutableTreeNode tc = containers.computeIfAbsent(sckey, key -> new DefaultMutableTreeNode(opsName(sc)));
        getTreeNode(structureRoot, containers, startOffset, sc.getBaseContainer()).add(tc);
        return tc;
    }

    static void tree(DefaultMutableTreeNode n, int depth, StringBuilder out) {
        out.append("  T " + "  ".repeat(depth) + n.getUserObject() + "\n");
        for (int i = 0; i < n.getChildCount(); i++) {
            tree((DefaultMutableTreeNode) n.getChildAt(i), depth + 1, out);
        }
    }

    static String opsName(NameDescription nd) {
        String alias = nd.getOpsName();
        return alias != null ? alias : nd.getName();
    }
}
