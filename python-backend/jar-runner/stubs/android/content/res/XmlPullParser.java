package android.content.res;

/** Minimal org.xmlpull.v1.XmlPullParser stub. */
public interface XmlPullParser {
    int START_DOCUMENT = 0;
    int END_DOCUMENT = 1;
    int START_TAG = 2;
    int END_TAG = 3;
    int TEXT = 4;
    int CDSECT = 5;
    int ENTITY_REF = 6;
    int IGNORABLE_WHITESPACE = 7;
    int PROCESSING_INSTRUCTION = 8;
    int COMMENT = 9;
    int DOCDECL = 10;
    int getEventType() throws Exception;
    int next() throws Exception;
    int nextTag() throws Exception;
    String getName();
    String getText();
    int getAttributeCount();
    String getAttributeValue(int index);
    String getAttributeValue(String namespace, String name);
    String getAttributeName(int index);
    boolean isEmptyElementTag() throws Exception;
    void require(int type, String namespace, String name) throws Exception;
    int getDepth();
    String getNamespace();
    String getPrefix();
    boolean isWhitespace();
    int getAttributeNameResource(int index);
    int getAttributeListValue(int index, String[] options, int defaultValue);
    boolean getAttributeBooleanValue(int index, boolean defaultValue);
    float getAttributeFloatValue(int index, float defaultValue);
    int getAttributeIntValue(int index, int defaultValue);
    int getAttributeUnsignedIntValue(int index, int defaultValue);
    String getAttributeType(int index);
    boolean isAttributeDefault(int index);
    int nextToken() throws Exception;
    void setInput(java.io.InputStream is, String encoding) throws Exception;
    void setInput(java.io.Reader reader) throws Exception;
    String getInputEncoding();
    int getLineNumber();
    int getColumnNumber();
    void defineEntityReplacementText(String entity, String replacement) throws Exception;
    String[] getNamespaces();
}