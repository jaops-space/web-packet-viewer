# Yamcs issues found (to report on github.com/yamcs/yamcs)

Found with Yamcs 5.14 while building the packet viewer; checked against `master` (`d221872f6`). No existing
issue found for any of them.

---

## 1. XtceAssembler writes a dynamic `BinaryDataEncoding` size as `<FixedValue>-1</FixedValue>`

`XtceAssembler.writeBinaryDataEncoding` always writes `SizeInBits/FixedValue` with `encoding.getSizeInBits()`.
A binary encoding whose size is a `DynamicValue` (or a leading size) is exported as a fixed `-1`, so the exported
XTCE no longer decodes the same packets.

Example, `examples/pus/src/main/yamcs/mdb/pus22.xml`:

```xml
<BinaryParameterType name="DetailReportTcPacketDataType">
  <BinaryDataEncoding>
    <SizeInBits>
      <DynamicValue>
        <ParameterInstanceRef parameterRef="length" />
        <LinearAdjustment slope="8" intercept="-48"/>
      </DynamicValue>
    </SizeInBits>
  </BinaryDataEncoding>
</BinaryParameterType>
```

is exported (`GET /api/mdb/{instance}/space-systems/{name}:exportXTCE`, or `new XtceAssembler().toXtce(mdb)`) as

```xml
<BinaryParameterType name="DetailReportTcPacketDataType">
  <BinaryDataEncoding>
    <SizeInBits>
      <FixedValue>-1</FixedValue>
    </SizeInBits>
  </BinaryDataEncoding>
</BinaryParameterType>
```

Expected: the `DynamicValue` (with its `LinearAdjustment`), as `writeStringDataEncoding` already does for strings
(`getDynamicBufferSize()`), and `LeadingSize` when the size type is a leading size.

---

## 2. XtceAssembler: NullPointerException on an `AbsoluteTimeArgumentType` without `ReferenceTime`

`writeAbsoluteTimeArgumentType` calls `writeReferenceTime(doc, atype.getReferenceTime())` unconditionally, and
`writeReferenceTime` dereferences it (`referenceTime.getOffsetFrom()`). An absolute time argument type without a
reference time, which the loader accepts, makes the whole export fail:

```xml
<AbsoluteTimeArgumentType name="PusTimeType">
  <Encoding>
    <BinaryDataEncoding>
      <SizeInBits><FixedValue>-1</FixedValue></SizeInBits>
      <ToBinaryTransformAlgorithm name="TimeBinaryEncoder">
        <AlgorithmText language="java"> org.yamcs.algo.TimeBinaryEncoder({type: CUC, epoch: UNIX, pfield: 0x2f, implicitPfield: false}) </AlgorithmText>
      </ToBinaryTransformAlgorithm>
    </BinaryDataEncoding>
  </Encoding>
</AbsoluteTimeArgumentType>
```

(`examples/pus/src/main/yamcs/mdb/pus.xml`). `GET /api/mdb/{instance}/space-systems/PUS:exportXTCE` fails
with the NullPointerException. The parameter version (`writeAbsoluteTimeParameterType`) checks for null
(`if (referenceTime != null)`); the argument version should do the same.

---

## 3. Yamcs-web: a change in an extension's directory deletes the deployed webapp (404 until restart)

When the webapp is deployed from the classpath (the normal case: no `staticRoot`), `WebFileDeployer.source` is
null. `setExtraSources` still starts a `Redeployer` that watches the extension directories
(`WebPlugin.addExtension`). On a change in one of them, `redeployQuietly()` runs

```java
FileUtils.deleteContents(target);
FileUtils.copyRecursively(source, target);   // source == null
```

The NullPointerException (from `FileUtils.copyRecursively`, `Path.getFileSystem()` on null) is not caught (only
`IOException | ParseException` are), so the `Redeployer` thread dies after having emptied `cache/yamcs-web`.
Every page then answers `404 Not Found: …/cache/yamcs-web/index.html` until Yamcs restarts.

To reproduce: run Yamcs with a plugin that registers an extension directory (`WebPlugin.addExtension`), then
modify or add a file in that directory.

Expected: with no source directory, redeploy the webapp from the classpath (as at startup) and the extensions,
or at least not delete the target; and catch runtime exceptions in `redeployQuietly` so the watcher survives.
