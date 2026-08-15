package android.util;

/** Minimal android.util.AttributeSet stub. */
public interface AttributeSet {
    int getAttributeCount();
    String getAttributeName(int index);
    String getAttributeValue(int index);
    String getAttributeValue(String namespace, String name);
    String getClassAttribute();
    String getIdAttribute();
    String getPositionDescription();
    int getAttributeNameResource(int index);
    int getAttributeListValue(int index, String[] options, int defaultValue);
    boolean getAttributeBooleanValue(int index, boolean defaultValue);
    boolean getAttributeBooleanValue(String namespace, String attribute, boolean defaultValue);
    float getAttributeFloatValue(int index, float defaultValue);
    float getAttributeFloatValue(String namespace, String attribute, float defaultValue);
    int getAttributeIntValue(int index, int defaultValue);
    int getAttributeIntValue(String namespace, String attribute, int defaultValue);
    int getAttributeUnsignedIntValue(int index, int defaultValue);
    int getAttributeUnsignedIntValue(String namespace, String attribute, int defaultValue);
    String getAttributeResourceValue(int index, String defaultValue);
    String getAttributeResourceValue(String namespace, String attribute, String defaultValue);
    int getAttributeResourceValue(int index, int defaultValue);
    int getAttributeResourceValue(String namespace, String attribute, int defaultValue);
    int getAttributeListValue(String namespace, String attribute, String[] options, int defaultValue);
}