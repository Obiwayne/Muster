package com.obiwayne.muster.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigInteger
import java.security.Principal
import java.security.PublicKey
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Date

class CertPinTest {
    private val der = "fake certificate bytes".toByteArray()
    private val expected = CertPin.sha256Hex(der)

    @Test fun sha256IsLowercaseHex() {
        assertEquals(64, expected.length)
        assertTrue(expected.all { it in '0'..'9' || it in 'a'..'f' })
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", CertPin.sha256Hex(ByteArray(0)))
    }

    @Test fun matchesIgnoringCaseAndColons() {
        assertTrue(CertPin.matches(der, expected))
        assertTrue(CertPin.matches(der, expected.uppercase().chunked(2).joinToString(":")))
        val flipped = (if (expected[0] == 'a') "b" else "a") + expected.drop(1)
        assertFalse(CertPin.matches(der, flipped))
        assertFalse(CertPin.matches(der, expected.take(32)))
        assertFalse(CertPin.matches(der, null))
    }

    @Test fun shortForm() {
        assertEquals("3F9A 21C0", CertPin.shortForm("3f9a21c0deadbeef"))
    }

    @Test fun trustManagerAcceptsOnlyThePin() {
        val cert = FakeCert(der)
        PinnedTrustManager(expected).checkServerTrusted(arrayOf(cert), "ECDHE_ECDSA")
        val other = PinnedTrustManager("0".repeat(64))
        try {
            other.checkServerTrusted(arrayOf(cert), "ECDHE_ECDSA")
            fail("should reject")
        } catch (_: CertificateException) {
        }
        assertEquals(expected, other.seen)
        val probe = PinnedTrustManager(null)
        try {
            probe.checkServerTrusted(arrayOf(cert), "RSA")
            fail("a probe trusts nothing")
        } catch (_: CertificateException) {
        }
        assertEquals(expected, probe.seen) // recorded for the manual-entry check
    }

    @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
    private class FakeCert(private val bytes: ByteArray) : X509Certificate() {
        override fun getEncoded() = bytes
        override fun checkValidity() {}
        override fun checkValidity(date: Date?) {}
        override fun getVersion() = 3
        override fun getSerialNumber(): BigInteger = BigInteger.ONE
        override fun getIssuerDN(): Principal = Principal { "CN=test" }
        override fun getSubjectDN(): Principal = Principal { "CN=test" }
        override fun getNotBefore() = Date(0)
        override fun getNotAfter() = Date(Long.MAX_VALUE)
        override fun getTBSCertificate() = bytes
        override fun getSignature() = bytes
        override fun getSigAlgName() = "none"
        override fun getSigAlgOID() = "0"
        override fun getSigAlgParams(): ByteArray? = null
        override fun getIssuerUniqueID(): BooleanArray? = null
        override fun getSubjectUniqueID(): BooleanArray? = null
        override fun getKeyUsage(): BooleanArray? = null
        override fun getBasicConstraints() = -1
        override fun verify(key: PublicKey?) {}
        override fun verify(key: PublicKey?, sigProvider: String?) {}
        override fun toString() = "FakeCert"
        override fun getPublicKey(): PublicKey? = null
        override fun hasUnsupportedCriticalExtension() = false
        override fun getCriticalExtensionOIDs(): MutableSet<String>? = null
        override fun getNonCriticalExtensionOIDs(): MutableSet<String>? = null
        override fun getExtensionValue(oid: String?): ByteArray? = null
    }
}
