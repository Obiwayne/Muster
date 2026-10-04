package com.obiwayne.muster.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairUriTest {
    private val fp = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"

    @Test fun parsesFullUri() {
        val info = PairUri.parse("muster://pair?c=K7M4QX&p=47910&f=$fp&n=WAYNE-PC&h=192.168.1.20,100.101.12.7,wayne-pc.tail1234.ts.net")!!
        assertEquals("K7M4QX", info.code)
        assertEquals(47910, info.port)
        assertEquals(fp, info.fingerprint)
        assertEquals("WAYNE-PC", info.pcName)
        assertEquals(listOf("192.168.1.20", "100.101.12.7", "wayne-pc.tail1234.ts.net"), info.hosts)
    }

    @Test fun decodesPercentEncodingAndDefaultsPort() {
        val info = PairUri.parse("muster://pair?c=k7m-4qx&f=${fp.uppercase()}&n=Obi%27s%20PC&h=192.168.1.20%2C10.0.0.5")!!
        assertEquals("K7M4QX", info.code)
        assertEquals(PairUri.DEFAULT_PORT, info.port)
        assertEquals(fp, info.fingerprint)
        assertEquals("Obi's PC", info.pcName)
        assertEquals(listOf("192.168.1.20", "10.0.0.5"), info.hosts)
    }

    @Test fun rejectsBadInput() {
        assertNull(PairUri.parse("https://example.com"))
        assertNull(PairUri.parse("muster://pair?c=K7M4Q&f=$fp&h=1.2.3.4")) // 5 chars
        assertNull(PairUri.parse("muster://pair?c=K7M4QI&f=$fp&h=1.2.3.4")) // I is not in the alphabet
        assertNull(PairUri.parse("muster://pair?c=K7M4QX&f=abcd&h=1.2.3.4")) // short fingerprint
        assertNull(PairUri.parse("muster://pair?c=K7M4QX&f=$fp")) // no hosts
        assertNull(PairUri.parse("muster://pair?c=K7M4QX&f=$fp&h=1.2.3.4&p=99999"))
    }

    @Test fun codesAndAddresses() {
        assertEquals("K7M4QX", PairUri.normalizeCode(" k7m-4qx "))
        assertNull(PairUri.normalizeCode("K7M-4Q0")) // 0 is excluded
        assertEquals("K7M-4QX", PairUri.displayCode("K7M4QX"))
        assertEquals("192.168.1.20" to 47910, PairUri.parseAddress("192.168.1.20"))
        assertEquals("192.168.1.20" to 5000, PairUri.parseAddress("https://192.168.1.20:5000/"))
        assertEquals("fe80::1" to 47910, PairUri.parseAddress("[fe80::1]"))
        assertNull(PairUri.parseAddress("1.2.3.4:http"))
    }
}
