package app.kybl.mobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals the secret-keys file (src/platform/vault.rs) with an AES-256-GCM key that lives in the
 * Android Keystore and can't be taken out of it. Called from Rust over JNI; errors are thrown and
 * come back to Rust as errors, never as empty data.
 *
 * Sealed layout: "KYB1", the IV's length (1 byte), the IV, then ciphertext with the GCM tag.
 */
object SecretBox {
  private const val ALIAS = "kybl-vault"
  private val MAGIC = "KYB1".toByteArray()
  private const val TAG_BITS = 128

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun existingKey(): SecretKey? = keyStore().getKey(ALIAS, null) as? SecretKey

  private fun newKey(): SecretKey {
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  @JvmStatic
  @Synchronized
  fun seal(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: newKey())
    val iv = cipher.iv
    val body = cipher.doFinal(plain)
    return MAGIC + byteArrayOf(iv.size.toByte()) + iv + body
  }

  @JvmStatic
  @Synchronized
  fun open(sealed: ByteArray): ByteArray {
    require(sealed.size > MAGIC.size + 1 && sealed.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) { "not a sealed file" }
    val ivLen = sealed[MAGIC.size].toInt()
    val start = MAGIC.size + 1
    require(ivLen in 1..32 && sealed.size > start + ivLen) { "damaged sealed file" }
    // never make a new key to open with: that could only fail, and would replace nothing
    val key = existingKey() ?: throw IllegalStateException("the key that sealed the secret keys is gone")
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed.copyOfRange(start, start + ivLen)))
    return cipher.doFinal(sealed.copyOfRange(start + ivLen, sealed.size))
  }
}
